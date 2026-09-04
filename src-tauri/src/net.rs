//! Shared HTTP plumbing for every outbound request Veglass makes itself.
//!
//! This exists because the same lesson was learned twice. `ureq` reads no
//! environment and has no Happy Eyeballs, so on a machine behind a proxy — or
//! with a filtered IPv6 route — the webview half of the application reaches the
//! internet and the native half does not. That was diagnosed and fixed once,
//! inside the Gemini client, and the two binary downloads (ffmpeg, yt-dlp) were
//! left connecting direct with a bare `ureq::get`. They then failed on exactly
//! the network the earlier fix was written for.
//!
//! So the plumbing lives here, and every caller gets the same agent: system
//! proxy honoured, IPv4 tried first, bounded connect timeout.
//!
//! Only the environment is consulted for the proxy, in the order every other
//! tool uses. Reading the Windows registry or macOS network settings would be a
//! better answer still, and is deliberately left for the day someone needs it.

use std::net::SocketAddr;
use std::time::Duration;

/// How long to wait for the *connection*.
///
/// Deliberately short. A TCP handshake that has not completed in eight seconds
/// is not going to, and with retries on top every second here is paid three
/// times over — which is how a machine with no route to a host used to spend a
/// silent minute before admitting it.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// The host part of a URL, for matching against `NO_PROXY`.
///
/// Deliberately not a URL parser: everything this is given is a constant in the
/// source or a link the user pasted, and all that is wanted is the authority.
pub fn host_of(url: &str) -> &str {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme);
    // Strip credentials and any port.
    let after_at = authority.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(authority);
    after_at.split(':').next().unwrap_or(after_at)
}

/// The proxy to use for `host`, and the raw value, for reporting.
///
/// `None` means "connect direct" — either nothing is configured, or `NO_PROXY`
/// exempts this host, or the configured value could not be parsed. That last
/// case is deliberate: failing the request outright would hide a working direct
/// route behind a typo in an environment variable.
pub fn proxy_for(host: &str) -> Option<(ureq::Proxy, String)> {
    let raw = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;

    if bypassed(host) {
        return None;
    }

    ureq::Proxy::new(&raw).ok().map(|proxy| (proxy, raw))
}

/// Whether `NO_PROXY` exempts this host. An entry of `*` exempts everything.
fn bypassed(host: &str) -> bool {
    ["NO_PROXY", "no_proxy"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|list| {
            list.split(',').map(str::trim).any(|entry| {
                entry == "*" || (!entry.is_empty() && host.contains(entry))
            })
        })
        .unwrap_or(false)
}

/// Resolved addresses, IPv4 first.
///
/// `ureq` tries addresses in the order the resolver returns them, one connect
/// timeout each. A machine whose IPv6 route is filtered — common on home and
/// hotel networks — therefore burns the whole budget on an AAAA record before
/// reaching a v4 address that works, while every browser on the same machine
/// races the two and never notices. Ordering the list is a workaround, not a
/// fix, but it costs nothing where IPv6 is healthy: v6 is still tried, second.
pub fn ipv4_first(netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
    use std::net::ToSocketAddrs;
    let mut addresses: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
    // Stable, so the resolver's own preference survives inside each family.
    addresses.sort_by_key(SocketAddr::is_ipv6);
    Ok(addresses)
}

/// An agent configured for `host`.
pub fn agent_for(host: &str, read_timeout: Duration) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(read_timeout)
        .resolver(ipv4_first as fn(&str) -> std::io::Result<Vec<SocketAddr>>);

    match proxy_for(host) {
        Some((proxy, _)) => builder.proxy(proxy).build(),
        None => builder.build(),
    }
}

/// Attempts before giving up on a transfer that has not started yet.
///
/// Five, with the backoff below, spans about twenty seconds. Three over two
/// seconds — the first version of this — was useless for the thing it was
/// written for: a resolver that goes away when a laptop wakes, or while a VPN
/// finishes connecting, is gone for tens of seconds, not for two.
const MAX_ATTEMPTS: u32 = 5;

/// Waited after attempt *n*, in milliseconds. Ends near twenty seconds total.
const BACKOFF_MS: [u64; 4] = [700, 1_800, 4_000, 8_000];

/// Fetches `url`, retrying a transport failure that could be a blip.
///
/// The reason this exists: a DNS lookup that fails once often succeeds a second
/// later. A laptop that just woke, a VPN finishing its handshake, a resolver
/// that had gone cold — none of those are a reason to abandon a download and
/// tell someone their network is broken, which is exactly what a single
/// `ureq::get(...).call()` did.
///
/// Only *transport* failures are retried. An HTTP status is an answer: a 404
/// means the release moved, and asking again three times only makes the user
/// wait longer for the same news.
///
/// `abort` is polled between attempts so a cancelled install does not sit out
/// the backoff.
pub fn fetch(
    url: &str,
    read_timeout: Duration,
    mut abort: impl FnMut() -> bool,
) -> std::result::Result<ureq::Response, String> {
    let agent = agent_for(host_of(url), read_timeout);
    let mut last = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if abort() {
            return Err("annulé".into());
        }

        match agent.get(url).call() {
            Ok(response) => return Ok(response),
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("le serveur a répondu {code}"));
            }
            Err(error) => {
                last = error.to_string();
                // A failure we have no reason to think is transient is not
                // worth three of the user's seconds.
                if !matches!(classify(&last), Fault::Dns | Fault::Timeout | Fault::Refused) {
                    break;
                }
            }
        }

        if attempt < MAX_ATTEMPTS {
            let wait = BACKOFF_MS[(attempt - 1) as usize];
            // Slept in slices so a cancelled install stops within a moment
            // rather than at the end of an eight-second pause.
            let mut left = wait;
            while left > 0 {
                if abort() {
                    return Err("annulé".into());
                }
                let slice = left.min(200);
                std::thread::sleep(Duration::from_millis(slice));
                left -= slice;
            }
        }
    }

    Err(last)
}

/// How a request was routed, for an error message.
pub fn route_of(host: &str) -> String {
    match proxy_for(host) {
        Some((_, raw)) => format!(" (via le proxy {raw})"),
        None => " (connexion directe, sans proxy)".to_string(),
    }
}

/// What a transport failure was, in the terms a message should use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// The name never resolved — WSAHOST_NOT_FOUND and friends.
    Dns,
    /// Accepted or ignored, never answered.
    Timeout,
    /// Something is there and said no.
    Refused,
    Other,
}

/// Classifies `ureq`'s own words.
///
/// A DNS failure is separated from a timeout because the two are fixed
/// differently: one is a name that does not resolve, the other a route that
/// does not carry. Telling someone to check their proxy when their DNS is down
/// sends them to the wrong place.
pub fn classify(error: &str) -> Fault {
    let lower = error.to_lowercase();

    if lower.contains("os error 11001")
        || lower.contains("no such host")
        || lower.contains("failed to lookup")
        || lower.contains("name or service not known")
        || lower.contains("temporary failure in name resolution")
        || lower.contains("dns")
    {
        return Fault::Dns;
    }
    if lower.contains("os error 10060")
        || lower.contains("os error 110")
        || lower.contains("os error 60")
        || lower.contains("timed out")
        || lower.contains("timeout")
    {
        return Fault::Timeout;
    }
    if lower.contains("os error 10061") || lower.contains("refused") {
        return Fault::Refused;
    }
    Fault::Other
}

/// A sentence a user can act on, for a failed download of `what` from `url`.
pub fn download_advice(what: &str, url: &str, error: &str) -> String {
    let host = host_of(url);
    let route = route_of(host);

    match classify(error) {
        Fault::Dns => format!(
            "Téléchargement de {what} impossible : le nom {host} n'a pas pu être résolu{route}. \
             C'est le DNS, pas le serveur — vérifiez votre connexion, un VPN actif, ou un DNS \
             d'entreprise qui filtre. Si votre réseau passe par un proxy, définissez la variable \
             d'environnement HTTPS_PROXY avant de lancer Veglass. Vous pouvez aussi installer \
             {what} vous-même et déposer le binaire dans le dossier « bin » de Veglass."
        ),
        Fault::Timeout => format!(
            "Téléchargement de {what} expiré{route} : {host} n'a jamais répondu. En général un \
             pare-feu, un proxy d'entreprise ou un VPN sur le trajet. Si votre réseau passe par \
             un proxy, définissez HTTPS_PROXY avant de lancer Veglass."
        ),
        Fault::Refused => format!(
            "Connexion à {host} refusée{route}. Quelque chose sur le trajet a fermé la porte."
        ),
        Fault::Other => format!("Téléchargement de {what} impossible{route} : {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_is_pulled_out_of_a_url() {
        assert_eq!(host_of("https://github.com/BtbN/FFmpeg-Builds/releases/x.zip"), "github.com");
        assert_eq!(host_of("https://example.com:8443/path"), "example.com");
        assert_eq!(host_of("http://user:pw@proxy.local:3128/"), "proxy.local");
        assert_eq!(host_of("github.com"), "github.com");
        assert_eq!(host_of(""), "");
    }

    #[test]
    fn the_users_own_error_reads_as_dns() {
        // Verbatim from the report that prompted this module.
        let raw = "Dns Failed: resolve dns name github.com:443: \
                   No such host is known. (os error 11001)";
        assert_eq!(classify(raw), Fault::Dns);
    }

    #[test]
    fn a_timeout_is_not_a_dns_failure() {
        assert_eq!(classify("os error 10060"), Fault::Timeout);
        assert_eq!(classify("connection timed out"), Fault::Timeout);
        assert_eq!(classify("os error 10061 connection refused"), Fault::Refused);
        assert_eq!(classify("certificate has expired"), Fault::Other);
    }

    #[test]
    fn dns_advice_names_the_host_and_a_way_out() {
        let message = download_advice(
            "ffmpeg",
            "https://github.com/BtbN/FFmpeg-Builds/releases/x.zip",
            "os error 11001 no such host is known",
        );
        assert!(message.contains("github.com"), "{message}");
        assert!(message.contains("DNS"), "{message}");
        assert!(message.contains("HTTPS_PROXY"), "{message}");
        // The manual way out matters most when the automatic one cannot work.
        assert!(message.contains("bin"), "{message}");
    }

    #[test]
    fn a_status_is_an_answer_not_a_blip() {
        // Nothing to retry: the release moved, and asking again wastes seconds.
        assert!(!matches!(classify("the server responded 404"), Fault::Dns));
    }

    #[test]
    fn only_transient_faults_are_worth_another_go() {
        let transient = |raw: &str| matches!(classify(raw), Fault::Dns | Fault::Timeout | Fault::Refused);

        assert!(transient("Dns Failed: no such host is known. (os error 11001)"));
        assert!(transient("connection timed out (os error 10060)"));
        assert!(transient("connection refused (os error 10061)"));
        // A bad certificate will be just as bad on the third attempt.
        assert!(!transient("invalid peer certificate: Expired"));
    }

    #[test]
    fn the_retry_gives_up_rather_than_looping() {
        // A host that cannot resolve, so every attempt fails the same way.
        let started = std::time::Instant::now();
        let outcome = fetch(
            "https://veglass-nonexistent-host-for-tests.invalid/x.zip",
            Duration::from_secs(2),
            || false,
        );
        assert!(outcome.is_err());
        // Five attempts and ~15s of backoff — long enough to ride out a blip,
        // bounded enough that it can never look like a hang.
        assert!(started.elapsed() < Duration::from_secs(60), "{:?}", started.elapsed());
    }

    #[test]
    fn a_cancelled_install_does_not_sit_out_the_backoff() {
        let outcome = fetch(
            "https://veglass-nonexistent-host-for-tests.invalid/x.zip",
            Duration::from_secs(2),
            || true,
        );
        assert_eq!(outcome.err().as_deref(), Some("annulé"));
    }

    /// The real thing, against the real host. Ignored by default because it
    /// needs a network; run with `cargo test -- --ignored --nocapture` when a
    /// download fails on a machine whose browser works fine.
    #[test]
    #[ignore]
    fn diagnose_the_real_download_host() {
        let url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
        let host = host_of(url);
        println!("host           = {host}");
        println!("route          ={}", route_of(host));

        match ipv4_first(&format!("{host}:443")) {
            Ok(addresses) => println!("getaddrinfo    = {addresses:?}"),
            Err(error) => println!("getaddrinfo    = FAILED: {error}"),
        }

        match fetch(url, Duration::from_secs(30), || false) {
            Ok(response) => println!(
                "fetch          = {} {}",
                response.status(),
                response.header("Content-Length").unwrap_or("?")
            ),
            Err(error) => println!("fetch          = FAILED: {error}"),
        }
    }

    #[test]
    fn ipv4_sorts_before_ipv6() {
        let mut addresses: Vec<SocketAddr> = vec![
            "[::1]:443".parse().expect("v6"),
            "127.0.0.1:443".parse().expect("v4"),
            "[::2]:443".parse().expect("v6"),
            "127.0.0.2:443".parse().expect("v4"),
        ];
        addresses.sort_by_key(SocketAddr::is_ipv6);

        assert!(addresses[0].is_ipv4() && addresses[1].is_ipv4());
        assert!(addresses[2].is_ipv6() && addresses[3].is_ipv6());
        // Stable: order inside each family is the resolver's own.
        assert_eq!(addresses[0].to_string(), "127.0.0.1:443");
        assert_eq!(addresses[2].to_string(), "[::1]:443");
    }
}

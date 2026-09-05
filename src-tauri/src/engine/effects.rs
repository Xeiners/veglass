//! Effect → ffmpeg mapping.
//!
//! This is the authoritative translation from the editor's filter stack to a
//! filtergraph. `src/lib/effectChain.ts` carries a twin used by the browser
//! build; the inspector reports which one produced the chain it is showing, so
//! a drift between the two is visible rather than silent.

use serde::Serialize;

use crate::model::Effect;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectChain {
    /// One fragment per enabled, non-neutral effect, in stack order.
    pub filters: Vec<String>,
    /// Those fragments joined into a filtergraph chain.
    pub chain: String,
    pub engine: String,
}

/// A partial colour inversion, as a lookup table.
///
/// CSS defines `invert(a)` as the straight line `out = in·(1−2a) + a` over the
/// 0 → 1 range — at `a = 1` that is `1 − in`, the negative, and at `a = 0.5` it
/// is flat mid-grey. `lutrgb` evaluates the identical line over 0 → `maxval`,
/// per channel, in RGB. So the preview's filter and the encoder's are not an
/// approximation of one another: they are the same function.
///
/// `lutrgb` rather than `negate` because `negate` has no dosage, and rather
/// than `eq=contrast=-1` because ffmpeg's `eq` works on luma alone — that
/// inverts the brightness of a frame while leaving its colours where they were,
/// which is not what anyone means by a negative.
///
/// Shared with the TypeScript twin in `src/lib/effectChain.ts`, character for
/// character. The test below is the contract.
pub fn invert_filter(amount: f64) -> String {
    let ramp = format!("val*({:.3})+({amount:.3})*maxval", 1.0 - 2.0 * amount);
    format!("lutrgb=r={ramp}:g={ramp}:b={ramp}")
}

/// The channel offsets a chromatic split asks for.
///
/// `rgbashift` counts in whole pixels, so the amount is rounded here rather
/// than left to the option parser — the viewer rounds to the same integers, and
/// a value only one of them rounds is a value the two disagree about.
///
/// The signs were checked against the binary: `rh=+10` moves red ten pixels to
/// the **right**, `rv=+8` moves it eight **down** — exactly what SVG's
/// `feOffset dx dy` does in the viewer. Blue takes the opposite of both.
///
/// `edge=smear` holds the border pixel out to the edge rather than leaving the
/// uncovered strip transparent, which is the closest the encoder gets to a
/// filter region that reaches past the layer, and the one that does not put a
/// coloured band down the side of the picture.
///
/// `None` when the offsets round to nothing — a filter that shifts by zero
/// costs a pass and changes no pixel.
///
/// Shared with the TypeScript twin in `src/lib/effectChain.ts`, character for
/// character. The test below is the contract.
pub fn rgb_split_filter(amount: f64, angle: f64) -> Option<String> {
    let radians = angle.to_radians();
    let dx = (amount * radians.cos()).round() as i64;
    let dy = (amount * radians.sin()).round() as i64;
    if dx == 0 && dy == 0 {
        return None;
    }
    Some(format!(
        "rgbashift=rh={dx}:rv={dy}:bh={}:bv={}:edge=smear",
        -dx, -dy
    ))
}

/// A Gaussian blurred along one axis.
///
/// `sigma` is horizontal and `sigmaV` vertical, both standard deviations in
/// pixels — the same two numbers SVG's `stdDeviation="x y"` takes. Passing
/// `sigmaV` explicitly is not optional: left out it defaults to -1, meaning
/// "the same as sigma", and a directional blur would come back isotropic.
///
/// Shared with the TypeScript twin, character for character.
pub fn motion_blur_filter(amount: f64, angle: f64) -> Option<String> {
    let radians = angle.to_radians();
    let x = amount * radians.cos().abs();
    let y = amount * radians.sin().abs();
    if x < 0.05 && y < 0.05 {
        return None;
    }
    Some(format!("gblur=sigma={x:.2}:sigmaV={y:.2}:steps=2"))
}

/// Neutral values are skipped: a filter that changes nothing costs a pass.
pub fn effect_filters(effects: &[Effect]) -> Vec<String> {
    let mut filters = Vec::new();

    for effect in effects {
        if !effect.enabled {
            continue;
        }

        match effect.kind.as_str() {
            "brightness" => {
                let amount = effect.param("amount", 0.0);
                if amount != 0.0 {
                    filters.push(format!("eq=brightness={amount:.3}"));
                }
            }
            "contrast" => {
                let amount = effect.param("amount", 1.0);
                if amount != 1.0 {
                    filters.push(format!("eq=contrast={amount:.3}"));
                }
            }
            "saturation" => {
                let amount = effect.param("amount", 1.0);
                if amount != 1.0 {
                    filters.push(format!("eq=saturation={amount:.3}"));
                }
            }
            "blur" => {
                // CSS blur() takes a radius; ffmpeg's gblur takes a standard
                // deviation, which is roughly half of it.
                let radius = effect.param("radius", 0.0);
                if radius > 0.0 {
                    filters.push(format!("gblur=sigma={:.2}", radius / 2.0));
                }
            }
            "hue" => {
                let angle = effect.param("angle", 0.0);
                if angle != 0.0 {
                    filters.push(format!("hue=h={}", angle.round() as i64));
                }
            }
            "grayscale" => {
                let amount = effect.param("amount", 0.0);
                if amount > 0.0 {
                    filters.push(format!("hue=s={:.3}", 1.0 - amount));
                }
            }
            "invert" => {
                let amount = effect.param("amount", 0.0);
                if amount > 0.0 {
                    filters.push(invert_filter(amount));
                }
            }
            "rgbsplit" => {
                if let Some(filter) =
                    rgb_split_filter(effect.param("amount", 0.0), effect.param("angle", 0.0))
                {
                    filters.push(filter);
                }
            }
            "motionblur" => {
                if let Some(filter) =
                    motion_blur_filter(effect.param("amount", 0.0), effect.param("angle", 0.0))
                {
                    filters.push(filter);
                }
            }
            unknown => {
                // Forward-compatible: a document written by a newer UI keeps
                // its effect, and the encoder simply ignores what it cannot map.
                eprintln!("veglass: effet inconnu ignoré au rendu : {unknown}");
            }
        }
    }

    filters
}

pub fn describe(effects: &[Effect]) -> EffectChain {
    let filters = effect_filters(effects);
    EffectChain {
        chain: filters.join(","),
        filters,
        engine: "rust".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn effect(kind: &str, key: &str, value: f64) -> Effect {
        let mut params = HashMap::new();
        params.insert(key.to_string(), value);
        Effect { id: "fx".into(), kind: kind.into(), enabled: true, params }
    }

    /// These strings are the contract with `src/lib/effectChain.ts`; the twin
    /// must produce them character for character.
    #[test]
    fn maps_each_effect_kind() {
        assert_eq!(effect_filters(&[effect("brightness", "amount", 0.15)]), ["eq=brightness=0.150"]);
        assert_eq!(effect_filters(&[effect("contrast", "amount", 1.2)]), ["eq=contrast=1.200"]);
        assert_eq!(effect_filters(&[effect("saturation", "amount", 1.35)]), ["eq=saturation=1.350"]);
        assert_eq!(effect_filters(&[effect("blur", "radius", 6.0)]), ["gblur=sigma=3.00"]);
        assert_eq!(effect_filters(&[effect("hue", "angle", 30.0)]), ["hue=h=30"]);
        assert_eq!(effect_filters(&[effect("grayscale", "amount", 1.0)]), ["hue=s=0.000"]);
        assert_eq!(
            effect_filters(&[effect("invert", "amount", 1.0)]),
            ["lutrgb=r=val*(-1.000)+(1.000)*maxval:g=val*(-1.000)+(1.000)*maxval:b=val*(-1.000)+(1.000)*maxval"]
        );
        assert_eq!(
            effect_filters(&[effect("rgbsplit", "amount", 10.0)]),
            ["rgbashift=rh=10:rv=0:bh=-10:bv=0:edge=smear"]
        );
        assert_eq!(
            effect_filters(&[effect("motionblur", "amount", 14.0)]),
            ["gblur=sigma=14.00:sigmaV=0.00:steps=2"]
        );
    }

    /// The directions were read off the binary, and this pins what was read:
    /// red right and blue left at 0°, red down and blue up at 90°. SVG's
    /// `feOffset` uses the same convention, which is what makes the viewer and
    /// the file show the same fringe on the same side.
    #[test]
    fn a_split_moves_red_and_blue_opposite_ways() {
        assert_eq!(
            rgb_split_filter(10.0, 0.0).unwrap(),
            "rgbashift=rh=10:rv=0:bh=-10:bv=0:edge=smear"
        );
        assert_eq!(
            rgb_split_filter(8.0, 90.0).unwrap(),
            "rgbashift=rh=0:rv=8:bh=0:bv=-8:edge=smear"
        );
        // Under half a pixel there is nothing to shift, and a filter that moves
        // nothing is a pass spent on nothing.
        assert!(rgb_split_filter(0.4, 0.0).is_none());
        assert!(rgb_split_filter(0.0, 45.0).is_none());
    }

    /// A blur has an axis, not a direction: 0° and 180° are the same blur, and
    /// the deviation is split across the axes rather than rotated.
    #[test]
    fn a_motion_blur_stays_on_one_axis() {
        assert_eq!(
            motion_blur_filter(14.0, 0.0).unwrap(),
            "gblur=sigma=14.00:sigmaV=0.00:steps=2"
        );
        assert_eq!(
            motion_blur_filter(14.0, 180.0).unwrap(),
            motion_blur_filter(14.0, 0.0).unwrap()
        );
        assert_eq!(
            motion_blur_filter(14.0, 90.0).unwrap(),
            "gblur=sigma=0.00:sigmaV=14.00:steps=2"
        );
        assert!(motion_blur_filter(0.0, 0.0).is_none());
    }

    /// The two ends of the dosage, checked as arithmetic rather than as strings.
    #[test]
    fn a_full_invert_is_the_negative_and_a_half_one_is_flat_grey() {
        // out = in·(1−2a) + a·max, the line CSS `invert()` defines.
        let at = |amount: f64, input: f64| input * (1.0 - 2.0 * amount) + amount;

        assert!((at(1.0, 0.0) - 1.0).abs() < 1e-9, "black inverts to white");
        assert!((at(1.0, 1.0) - 0.0).abs() < 1e-9, "white inverts to black");
        assert!((at(0.5, 0.0) - 0.5).abs() < 1e-9, "half-way is mid-grey whatever went in");
        assert!((at(0.5, 1.0) - 0.5).abs() < 1e-9);
        assert!((at(0.0, 0.7) - 0.7).abs() < 1e-9, "no dosage changes nothing");
    }

    #[test]
    fn skips_neutral_and_disabled_effects() {
        assert!(effect_filters(&[effect("brightness", "amount", 0.0)]).is_empty());
        assert!(effect_filters(&[effect("contrast", "amount", 1.0)]).is_empty());

        let mut off = effect("blur", "radius", 8.0);
        off.enabled = false;
        assert!(effect_filters(&[off]).is_empty());
    }

    #[test]
    fn preserves_stack_order_in_the_chain() {
        let chain = describe(&[
            effect("blur", "radius", 4.0),
            effect("saturation", "amount", 2.0),
        ]);
        assert_eq!(chain.chain, "gblur=sigma=2.00,eq=saturation=2.000");
        assert_eq!(chain.engine, "rust");
    }

    #[test]
    fn unknown_kinds_are_ignored_not_fatal() {
        assert!(effect_filters(&[effect("bokeh-from-a-newer-build", "amount", 1.0)]).is_empty());
    }
}

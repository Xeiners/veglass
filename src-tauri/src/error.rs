use serde::{Serialize, Serializer};

/// Every command failure crosses the IPC bridge as a plain string, which is
/// what the TypeScript side expects from a rejected `invoke`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("échec d'accès disque : {0}")]
    Io(#[from] std::io::Error),

    #[error("projet illisible : {0}")]
    Json(#[from] serde_json::Error),

    #[error("chemin applicatif indisponible : {0}")]
    Path(#[from] tauri::Error),

    #[error("identifiant de projet invalide")]
    InvalidId,

    #[error("rasterisation illisible : {0}")]
    Bake(String),

    #[error("installation de ffmpeg : {0}")]
    Install(String),
}

impl Serialize for Error {
    // Fully qualified: the `Result` alias below shadows `std::result::Result`
    // inside this module, and it only takes one type parameter.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

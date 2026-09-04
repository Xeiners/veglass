//! The AI suite's native half.
//!
//! A small, fixed set of responsibilities:
//!
//! * [`secrets`] holds the API keys, out of reach of the webview;
//! * [`gemini`] performs the HTTP call and turns a failure into something the
//!   interface can act on;
//! * [`eleven`] does the same for text-to-speech, and writes the takes it gets
//!   back to disk, because a voice-over is a media asset like any other;
//! * [`audio`] gets sound off the disk — compressed for the model, or measured
//!   for silence detection;
//! * [`frame`] pulls a single still, for previewing a cut the model proposed —
//!   and, for the tutorial generator, for showing the model the screen itself.
//!
//! What a request *says* is not decided here. Prompts, JSON schemas and the
//! translation of an answer into timeline edits all live in `src/lib/ai/`,
//! where they are typed against the document model and can be tested without a
//! network. This module would look the same if the editor spoke to a different
//! provider tomorrow.

pub mod audio;
pub mod eleven;
pub mod error;
pub mod frame;
pub mod gemini;
pub mod secrets;

pub use error::{AiError, AiErrorKind};

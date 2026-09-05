pub mod ai;
pub mod commands;
pub mod engine;
pub mod error;
pub mod model;
pub mod net;
pub mod proc;
pub mod online;

/// Whether `tauri.conf.json` carries an `updater` plugin block.
///
/// The plugin's config has a **required** `pubkey`, with no default: registered
/// against a configuration that is not there, it fails to deserialize, the
/// plugin fails to initialise, and the application does not start at all.
///
/// So it is registered only once it has something to read. That is not a
/// workaround — it is the behaviour worth having. A build with no update
/// endpoint is a perfectly good build; it simply never asks about updates, and
/// the front-end treats the missing command as "nothing to report" (see
/// `src/lib/updater.ts`). Adding the block, with a key and an endpoint, is what
/// switches the whole feature on.
fn updater_configured(context: &tauri::Context<tauri::Wry>) -> bool {
    context
        .config()
        .plugins
        .0
        .get("updater")
        .map(|value| !value.is_null())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    let mut builder = tauri::Builder::default()
        // One render at a time; the handle lets a cancel request reach the child.
        .manage(std::sync::Arc::new(engine::ExportControl::default()))
        // Several downloads may run at once, so each is stopped by its own id
        // rather than through the single slot the exporter uses.
        .manage(std::sync::Arc::new(online::DownloadControl::default()))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Where a self-installed ffmpeg lives. Resolved once, at startup,
            // so `locate_binary` can find it without an app handle.
            let dir = tauri::Manager::path(app).app_data_dir()?.join("bin");
            engine::install::remember_install_dir(dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::projects_dir,
            commands::project::list_projects,
            commands::project::load_project,
            commands::project::save_project,
            commands::project::delete_project,
            commands::media::resolve_media,
            commands::media::parent_directory,
            commands::media::list_media_folder,
            commands::media::write_baked_layer,
            commands::media::write_baked_frame,
            commands::media::read_media_bytes,
            commands::media::clear_baked_layers,
            commands::engine::process_timeline_segments,
            commands::engine::describe_effect_chain,
            commands::engine::encoder_status,
            commands::engine::install_ffmpeg,
            commands::engine::adopt_ffmpeg,
            commands::engine::export_render,
            commands::engine::cancel_export,
            commands::ai::ai_key_status,
            commands::ai::ai_set_key,
            commands::ai::ai_set_key_unchecked,
            commands::ai::ai_clear_key,
            commands::ai::ai_list_models,
            commands::ai::ai_generate,
            commands::ai::ai_audio_excerpt,
            commands::ai::ai_audio_envelope,
            commands::ai::ai_audio_onsets,
            commands::ai::ai_poster,
            commands::ai::ai_scene_cuts,
            commands::ai::voice_key_status,
            commands::ai::voice_set_key,
            commands::ai::voice_set_key_unchecked,
            commands::ai::voice_clear_key,
            commands::ai::voice_list,
            commands::ai::voice_speak,
            commands::ai::voice_preview,
            commands::ai::voice_discard,
            commands::system::open_external,
            commands::system::open_binaries_dir,
            commands::online::ytdlp_status,
            commands::online::install_ytdlp,
            commands::online::search_youtube,
            commands::online::get_media_formats,
            commands::online::download_media,
            commands::online::cancel_download,
        ]);

    // `process` comes along with it: relaunching after an install is the only
    // thing the app needs from it, so shipping it alone would be dead weight.
    if updater_configured(&context) {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .run(context)
        .expect("erreur au lancement de Veglass");
}

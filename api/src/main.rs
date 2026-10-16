mod clearance;
mod config;
mod domains;
mod error;
mod fingerprint;
mod keys;
mod models;
mod netrep;
mod pat;
mod pow;
mod probe;
mod reputation;
mod risk;
mod routes;
mod state;
mod stats;

use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    extract::Request,
    http::{header, HeaderValue, Method},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

use crate::{config::Config, error::ApiError, routes::*, state::AppState};

/// Mutating dashboard requests must be JSON. Together with `SameSite=Strict`
/// session cookies this blocks cross-site form posts (CSRF).
async fn require_json(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let is_json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if safe || is_json {
        next.run(req).await
    } else {
        ApiError::UnsupportedMediaType.into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "roundabout_api=info,tower_http=info".into()),
        )
        .init();

    let cfg = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await
        .context("connecting to Postgres")?;
    sqlx::migrate!().run(&db).await.context("running migrations")?;
    let redis = redis::Client::open(cfg.redis_url.as_str())?
        .get_connection_manager()
        .await
        .context("connecting to Redis")?;

    let netrep = Arc::new(netrep::NetRep::new(&cfg));
    if cfg.netrep_fetch {
        netrep.spawn_refresh();
    }
    let pat = cfg.pat_enabled.then(|| Arc::new(pat::PatIssuer::new(cfg.pat_issuer.clone())));
    if let Some(p) = &pat {
        p.spawn_refresh();
    }

    let clearance = Arc::new(clearance::ClearanceSigner::load_or_create(&db).await?);
    let mut variants: Vec<String> = std::fs::read_dir(&cfg.widget_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.starts_with("frame.v") && n.ends_with(".js"))
                .collect()
        })
        .unwrap_or_default();
    variants.sort();
    tracing::info!("serving {} obfuscated frame variant(s)", variants.len());

    let state = AppState {
        db,
        redis,
        cfg: Arc::new(cfg.clone()),
        netrep,
        pat,
        clearance,
        frame_variants: Arc::new(variants),
    };

    let admin = Router::new()
        .route("/config", get(auth::config))
        .route("/auth/signup", post(auth::signup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/sites", get(sites::list).post(sites::create))
        .route("/sites/{id}", get(sites::get).patch(sites::update).delete(sites::delete))
        .route("/sites/{id}/rotate-secret", post(sites::rotate_secret))
        .route("/sites/{id}/revoke-previous-secret", post(sites::revoke_previous_secret))
        .route("/keys", get(api_keys::list).post(api_keys::create))
        .route("/keys/{id}", axum::routing::delete(api_keys::delete))
        .route("/orgs", get(orgs::list).post(orgs::create))
        .route("/orgs/{id}", axum::routing::patch(orgs::rename).delete(orgs::delete))
        .route("/orgs/{id}/members", get(orgs::members))
        .route("/orgs/{id}/members/{user_id}", axum::routing::patch(orgs::update_member).delete(orgs::remove_member))
        .route("/orgs/{id}/invites", get(orgs::invites).post(orgs::create_invite))
        .route("/orgs/{id}/invites/{invite_id}", axum::routing::delete(orgs::revoke_invite))
        .route("/invites/{token}", get(orgs::preview_invite))
        .route("/invites/{token}/accept", post(orgs::accept_invite))
        .route("/sites/{id}/stats", get(sites::stats))
        .route("/sites/{id}/test-verify", post(sites::test_verify))
        .layer(middleware::from_fn(require_json));

    let v1 = Router::new()
        .route("/frame", get(challenge::frame))
        .route("/challenge", post(challenge::create))
        .route("/solve", post(challenge::solve))
        .route("/probe/{file}", get(challenge::probe_js))
        .route("/pat/{id}", get(challenge::pat_redeem))
        .route("/siteverify", post(siteverify::siteverify))
        .route("/feedback", post(siteverify::feedback))
        .route("/clearance/keys", get(routes::clearance::keys))
        .route("/clearance/check", get(routes::clearance::check))
        .route("/clearance/verify", post(routes::clearance::verify))
        .route("/gate", get(routes::clearance::gate));

    // Widget assets are embedded by third-party pages; keep the cache short so
    // fixes roll out quickly.
    let widget = Router::new()
        .fallback_service(ServeDir::new(&cfg.widget_dir))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=300"),
        ));

    let index = Path::new(&cfg.dashboard_dir).join("index.html");
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", admin)
        .nest("/v1", v1)
        .nest("/widget", widget)
        .fallback_service(ServeDir::new(&cfg.dashboard_dir).fallback(ServeFile::new(index)))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!("listening on {} (public url {})", cfg.bind_addr, cfg.public_url);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

use std::sync::Arc;

use redis::aio::ConnectionManager;
use sqlx::PgPool;

use crate::{clearance::ClearanceSigner, config::Config, netrep::NetRep, pat::PatIssuer};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub cfg: Arc<Config>,
    pub netrep: Arc<NetRep>,
    pub pat: Option<Arc<PatIssuer>>,
    pub clearance: Arc<ClearanceSigner>,
    /// Obfuscated frame.js builds (`frame.v0.js`…) to rotate between.
    pub frame_variants: Arc<Vec<String>>,
}

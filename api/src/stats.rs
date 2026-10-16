use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub enum Stat {
    Issued,
    Solved,
    Failed,
    Interactive,
    Verified,
    VerifyFailed,
    Reported,
    Pat,
}

impl Stat {
    fn column(self) -> &'static str {
        match self {
            Stat::Issued => "issued",
            Stat::Solved => "solved",
            Stat::Failed => "failed",
            Stat::Interactive => "interactive",
            Stat::Verified => "verified",
            Stat::VerifyFailed => "verify_failed",
            Stat::Reported => "reported",
            Stat::Pat => "pat",
        }
    }
}

/// Fire-and-forget daily counter increment, kept off the request's hot path.
pub fn record(db: &PgPool, site_id: Option<Uuid>, stat: Stat) {
    let Some(site_id) = site_id else { return };
    let db = db.clone();
    tokio::spawn(async move {
        let col = stat.column();
        let sql = format!(
            "INSERT INTO site_stats_daily (site_id, day, {col}) VALUES ($1, CURRENT_DATE, 1) \
             ON CONFLICT (site_id, day) DO UPDATE SET {col} = site_stats_daily.{col} + 1"
        );
        if let Err(e) = sqlx::query(&sql).bind(site_id).execute(&db).await {
            tracing::warn!(error = ?e, ?stat, "failed to record stat");
        }
    });
}

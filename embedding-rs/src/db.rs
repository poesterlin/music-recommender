use anyhow::{anyhow, bail, Context, Result};
use postgres::{Client, NoTls};

pub const EXPECTED_MODEL: &str = "openl3-512";
pub const EXPECTED_VERSION: i32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackRow {
    pub uri: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingSpaceInfo {
    pub version: i32,
    pub model: String,
    pub dimensions: i32,
    pub track_count: i32,
}

pub fn connect(database_url: &str) -> Result<Client> {
    Client::connect(database_url, NoTls).context("connect to PostgreSQL")
}

/// Verify the database-side prerequisites before any model work or writes.
pub fn preflight(
    client: &mut Client,
    expected_version: i32,
    expected_model: &str,
) -> Result<EmbeddingSpaceInfo> {
    let trigger_enabled: bool = client
        .query_one(
            "SELECT EXISTS (
                 SELECT 1
                 FROM pg_trigger
                 WHERE tgrelid = 'public.track'::regclass
                   AND tgname = 'track_centered_embedding_sync'
                   AND NOT tgisinternal
                   AND tgenabled IN ('O', 'A')
             ) AS enabled",
            &[],
        )
        .context("check centered-embedding trigger")?
        .get("enabled");
    if !trigger_enabled {
        bail!("track_centered_embedding_sync trigger is missing or disabled");
    }

    let row = client
        .query_one(
            "SELECT version, model, array_length(mean_embedding::real[], 1) AS dimensions, track_count
             FROM public.embedding_space
             ORDER BY version DESC
             LIMIT 1",
            &[],
        )
        .context("read active embedding space")?;
    let info = EmbeddingSpaceInfo {
        version: row.get("version"),
        model: row.get("model"),
        dimensions: row.get("dimensions"),
        track_count: row.get("track_count"),
    };
    if info.version != expected_version {
        bail!(
            "active embedding space version is {}; expected {}",
            info.version,
            expected_version
        );
    }
    if info.model != expected_model {
        bail!(
            "active embedding model is {}; expected {}",
            info.model,
            expected_model
        );
    }
    if info.dimensions != 512 {
        bail!(
            "active embedding space has {} dimensions; expected 512",
            info.dimensions
        );
    }
    if info.track_count <= 0 {
        bail!("active embedding space has no tracks");
    }
    Ok(info)
}

/// Read one bounded, stable keyset page. `after` is the last URI from the
/// previous page; no OFFSET scan is used.
pub fn fetch_unembedded_page(
    client: &mut Client,
    after: Option<&str>,
    limit: i64,
) -> Result<Vec<TrackRow>> {
    if limit <= 0 {
        bail!("page size must be positive");
    }
    let rows = if let Some(after) = after {
        client.query(
            "SELECT uri, name, artist, album
             FROM public.track
             WHERE embedding IS NULL
               AND (skip IS NULL OR skip = FALSE)
               AND (uri COLLATE \"C\") > ($1::text COLLATE \"C\")
             ORDER BY uri COLLATE \"C\"
             LIMIT $2::bigint",
            &[&after, &limit],
        )?
    } else {
        client.query(
            "SELECT uri, name, artist, album
             FROM public.track
             WHERE embedding IS NULL
               AND (skip IS NULL OR skip = FALSE)
             ORDER BY uri COLLATE \"C\"
             LIMIT $1::bigint",
            &[&limit],
        )?
    };

    rows.into_iter()
        .map(|row| {
            let uri: String = row.get("uri");
            if uri.is_empty() {
                return Err(anyhow!("database returned an empty track URI"));
            }
            Ok(TrackRow {
                uri,
                name: row.get("name"),
                artists: row.get("artist"),
                album: row.get("album"),
            })
        })
        .collect()
}

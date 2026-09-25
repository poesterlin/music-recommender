use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "m4a", "ogg"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackMetadata {
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
}

#[derive(Clone, Debug, Default)]
pub struct AudioFileIndex {
    by_name: HashMap<String, Vec<PathBuf>>,
}

impl AudioFileIndex {
    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    pub fn candidates(&self, name: &str) -> &[PathBuf] {
        self.by_name
            .get(&sanitize_component(name).to_lowercase())
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Match the lookup rules used by the existing Python worker.
    pub fn find(&self, track: &TrackMetadata) -> Option<&Path> {
        let name = sanitize_component(&track.name);
        if name.is_empty() || track.artists.is_empty() {
            return None;
        }

        let candidates = self.candidates(&name);
        if candidates.is_empty() {
            return None;
        }
        if candidates.len() == 1 {
            return candidates.first().map(PathBuf::as_path);
        }

        let album = sanitize_component(&track.album).to_lowercase();
        if !album.is_empty() {
            if let Some(path) = candidates.iter().find(|path| {
                path.to_string_lossy()
                    .to_lowercase()
                    .contains(album.as_str())
            }) {
                return Some(path.as_path());
            }
        }

        candidates.first().map(PathBuf::as_path)
    }
}

pub fn build_audio_index(base_path: impl AsRef<Path>) -> std::io::Result<AudioFileIndex> {
    let base_path = base_path.as_ref();
    let mut files = Vec::new();
    collect_audio_files(base_path, &mut files)?;
    files.sort();

    let mut by_name: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in files {
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let lower = stem.to_lowercase();
        push_unique(&mut by_name, lower.clone(), path.clone());

        // Music libraries commonly prefix tracks with a two-digit track number.
        // Match the Python expression ^(\d{2})\s*-\s*(.+)$ without adding a
        // regular-expression dependency to the worker.
        let bytes = stem.as_bytes();
        if bytes.len() > 3 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() {
            let mut separator = 2;
            while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                separator += 1;
            }
            if bytes.get(separator) == Some(&b'-') {
                let mut rest = &stem[separator + 1..];
                while rest
                    .chars()
                    .next()
                    .map(|character| character.is_whitespace())
                    .unwrap_or(false)
                {
                    rest = &rest[1..];
                }
                if !rest.is_empty() {
                    push_unique(&mut by_name, rest.to_lowercase(), path);
                }
            }
        }
    }

    Ok(AudioFileIndex { by_name })
}

fn collect_audio_files(path: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        if child.is_dir() {
            collect_audio_files(&child, files)?;
        } else if child.is_file() && has_audio_extension(&child) {
            files.push(child);
        }
    }
    Ok(())
}

fn has_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .map(|value| AUDIO_EXTENSIONS.contains(&value.as_str()))
        .unwrap_or(false)
}

fn push_unique(map: &mut HashMap<String, Vec<PathBuf>>, key: String, path: PathBuf) {
    let values = map.entry(key).or_default();
    if !values.contains(&path) {
        values.push(path);
    }
}

fn sanitize_component(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '/' | ':' | '?' => '_',
            other => other,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn sanitizes_and_indexes_track_numbers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let path = root.join("01 - Artist - Song.mp3");
        File::create(&path).unwrap();
        let index = build_audio_index(root).unwrap();

        assert_eq!(index.candidates("01 - artist - song"), &[path.clone()]);
        assert_eq!(index.candidates("Artist - Song"), &[path]);
    }

    #[test]
    fn disambiguates_by_album_and_preserves_python_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let first = root.join("A/album-one/song.mp3");
        let second = root.join("B/album-two/song.mp3");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        File::create(&first).unwrap();
        File::create(&second).unwrap();
        let index = build_audio_index(root).unwrap();

        let track = TrackMetadata {
            name: "Song".into(),
            artists: vec!["Artist".into()],
            album: "album-two".into(),
        };
        assert_eq!(index.find(&track), Some(second.as_path()));

        let no_album = TrackMetadata {
            name: "Song".into(),
            artists: vec!["Artist".into()],
            album: String::new(),
        };
        assert_eq!(index.find(&no_album), Some(first.as_path()));
    }
}

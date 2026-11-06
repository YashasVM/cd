use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub device_name: String,
    pub download_dir: String,
}

impl Preferences {
    pub fn load(
        path: &Path,
        default_download: PathBuf,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        match fs::read(path) {
            Ok(bytes) => {
                let preferences: Self = serde_json::from_slice(&bytes)?;
                preferences.validate()?;
                Ok(preferences)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                device_name: "My computer".into(),
                download_dir: default_download.to_string_lossy().into_owned(),
            }),
            Err(e) => Err(e.into()),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.device_name.trim().is_empty()
            || self.device_name.chars().count() > 48
            || self.device_name.len() > 80
            || self.device_name.chars().any(char::is_control)
        {
            return Err(
                "Choose a device name of 1–48 printable characters and at most 80 UTF-8 bytes."
                    .into(),
            );
        }
        if !Path::new(&self.download_dir).is_absolute() {
            return Err("Choose an absolute path for the receive folder.".into());
        }
        Ok(())
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        let pending = path.with_extension("pending");
        let mut file = fs::File::create(&pending).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&pending, path).map_err(|e| e.to_string())
    }
}

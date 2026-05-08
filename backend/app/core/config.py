"""Runtime settings for the BioVoice backend."""

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class Settings:
    sample_rate: int = 16000
    similarity_threshold: float = 0.75
    deepfake_threshold: float = 0.50
    min_enrollment_samples: int = 3
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173"])
    aasist_weights_path: Path = Path(__file__).resolve().parents[3] / "models" / "aasist.pt"
    database_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "biovoice.sqlite3"


settings = Settings()

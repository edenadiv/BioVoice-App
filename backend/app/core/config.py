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
    aasist_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "aasist.pt"
    redimnet_weights_path: Path = Path(__file__).resolve().parents[3] / "backend" / "models" / "redimnet_b5.pt"
    database_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "biovoice.sqlite3"
    reference_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "reference_samples"
    generated_samples_path: Path = Path(__file__).resolve().parents[3] / "backend" / "data" / "generated_samples"
    xtts_model_path: Path = Path(__file__).resolve().parents[3] / "XTTS-v2"
    xtts_default_language: str = "en"
    xtts_output_sample_rate: int = 24000


settings = Settings()

"""App settings, read from environment variables (or a .env file).

pydantic-settings maps each field to an environment variable with the same
name in upper case: `stories_per_day` <- STORIES_PER_DAY, and so on. It also
converts the text to the right type (int, Path, bool) and fails loudly if a
value is invalid.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Storage: JSON files in data_dir, or Postgres when database_url is set.
    data_dir: Path = Path("data")
    database_url: str = ""

    # Web Push identity. Generated and saved automatically if left empty.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@example.com"

    # Daily edition: publish the N most important stories once a day.
    # 0 = continuous mode (refresh every refresh_minutes instead).
    stories_per_day: int = 5
    shortlist_size: int = 15  # candidates read in full before picking
    edition_hour: int = 8  # 0-23, in edition_timezone
    edition_timezone: str = "UTC"

    # Continuous mode only.
    refresh_minutes: int = 30
    max_summaries_per_run: int = 15

    # Feed rules.
    min_relevance: int = 5  # stories scoring below this (0-10) are hidden
    max_articles: int = 600
    max_age_days: int = 14

    admin_token: str = ""  # enables POST /api/refresh
    scheduler_enabled: bool = True  # tests turn this off

    @property
    def edition_mode(self) -> bool:
        return self.stories_per_day > 0


settings = Settings()

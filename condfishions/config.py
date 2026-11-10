"""Load spots, species and home config from YAML."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"

TIDE_PHASES = (
    "low_slack", "rising_early", "rising_mid", "rising_late",
    "high_slack", "falling_early", "falling_mid", "falling_late",
)
LIGHT_PERIODS = ("dawn", "day", "dusk", "night")
EXPOSED_TYPES = {"rock", "rockwall", "beach"}


@dataclass
class Spot:
    id: str
    name: str
    region: str
    state: str
    lat: float
    lon: float
    type: str
    tidal: bool
    facing: float
    shelter: float
    species: list[str]
    swell_max: float | None = None
    extra_min: int = 0
    access: str = "car"
    permit: str | None = None
    marine: tuple[float, float] | None = None
    tide_offset_min: int = 0  # shift model tide times (e.g. upriver lag); calibrate vs MSQ
    verified: bool = False

    @property
    def fresh(self) -> bool:
        return self.type.startswith("fresh")

    @property
    def marine_point(self) -> tuple[float, float]:
        return tuple(self.marine) if self.marine else (self.lat, self.lon)


@dataclass
class Species:
    id: str
    name: str
    season: list[float]
    light: dict[str, float]
    tide: dict[str, float] | None
    sst: list[float] | None
    swell_pref: str
    rain_pref: str
    spring_pref: float
    base_rate: float
    weights: dict[str, float]
    notes: str = ""


@dataclass
class Regulation:
    id: str
    species: list[str]
    state: str
    applies_to: str
    start: str  # "MM-DD"
    end: str
    action: str  # closed | catch_and_release | permit
    text: str


@dataclass
class Home:
    name: str
    lat: float
    lon: float
    max_travel_min: int = 120


@dataclass
class Config:
    spots: list[Spot]
    species: dict[str, Species]
    regulations: list[Regulation]
    home: Home
    raw_species_yaml: dict = field(default_factory=dict, repr=False)

    def spot(self, spot_id: str) -> Spot:
        return next(s for s in self.spots if s.id == spot_id)


def _read(name: str, config_dir: Path) -> dict:
    with open(config_dir / name, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_config(config_dir: Path = CONFIG_DIR) -> Config:
    spots_y = _read("spots.yaml", config_dir)
    species_y = _read("species.yaml", config_dir)
    home_y = _read("home.yaml", config_dir)

    spots = [Spot(**s) for s in spots_y["spots"]]
    default_w = species_y["defaults"]["weights"]
    species = {}
    for sid, s in species_y["species"].items():
        w = dict(default_w)
        w.update(s.get("weights") or {})
        species[sid] = Species(
            id=sid, name=s["name"], season=s["season"], light=s["light"],
            tide=s.get("tide"), sst=s.get("sst"), swell_pref=s.get("swell_pref", "none"),
            rain_pref=s.get("rain_pref", "neutral"), spring_pref=s.get("spring_pref", 0.0),
            base_rate=s["base_rate"], weights=w, notes=s.get("notes", ""),
        )
    regs = [
        Regulation(id=r["id"], species=r["species"], state=r["state"], applies_to=r["applies_to"],
                   start=r["from"], end=r["to"], action=r["action"], text=r["text"])
        for r in species_y.get("regulations", [])
    ]
    _validate(spots, species)
    return Config(spots=spots, species=species, regulations=regs, home=Home(**home_y),
                  raw_species_yaml=species_y)


def _validate(spots: list[Spot], species: dict[str, Species]) -> None:
    ids = [s.id for s in spots]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"duplicate spot ids: {dupes}")
    for s in spots:
        unknown = set(s.species) - set(species)
        if unknown:
            raise ValueError(f"{s.id}: unknown species {unknown}")
        if s.type in EXPOSED_TYPES and s.type != "jetty" and s.swell_max is None and s.shelter < 0.5:
            raise ValueError(f"{s.id}: exposed spot needs swell_max")
    for sp in species.values():
        if len(sp.season) != 12:
            raise ValueError(f"{sp.id}: season needs 12 values")
        if sp.tide is not None and set(sp.tide) != set(TIDE_PHASES):
            raise ValueError(f"{sp.id}: tide needs all phases {TIDE_PHASES}")


# ── travel / range ─────────────────────────────────────────────────────────────

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def estimate_travel_min(home_lat: float, home_lon: float, spot: Spot) -> int:
    """Rough door-to-spot minutes: straight-line x road factor at a blended speed,
    plus fixed extras (ferry, 4WD). Good enough to filter a catalogue; per-spot
    `extra_min` absorbs ferries, walk-ins and known slow roads."""
    km = haversine_km(home_lat, home_lon, spot.lat, spot.lon) * 1.25
    speed = 40 if km < 25 else 80 if km > 60 else 60
    return int(round(km / speed * 60 + 5 + (spot.extra_min or 0)))


def spots_in_range(cfg: Config, lat: float | None = None, lon: float | None = None,
                   max_min: int | None = None) -> list[tuple[Spot, int]]:
    lat = cfg.home.lat if lat is None else lat
    lon = cfg.home.lon if lon is None else lon
    max_min = cfg.home.max_travel_min if max_min is None else max_min
    out = [(s, estimate_travel_min(lat, lon, s)) for s in cfg.spots]
    return sorted([(s, t) for s, t in out if t <= max_min], key=lambda x: x[1])

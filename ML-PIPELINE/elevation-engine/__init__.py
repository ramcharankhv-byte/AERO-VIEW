"""elevation_engine — SIH 26011 Input 3: decoupled hybrid elevation."""

try:  # package import
    from .pipeline import generate_elevation_layer
    from .ground import robust_ground_sample
    from .overture import get_overture_buildings
    from .consensus import fuse_heights
except ImportError:  # top-level import (folder itself on path, Kaggle flat)
    from pipeline import generate_elevation_layer  # type: ignore[import-not-found]
    from ground import robust_ground_sample  # type: ignore[import-not-found]
    from overture import get_overture_buildings  # type: ignore[import-not-found]
    from consensus import fuse_heights  # type: ignore[import-not-found]

__all__ = [
    "generate_elevation_layer",
    "robust_ground_sample",
    "get_overture_buildings",
    "fuse_heights",
]

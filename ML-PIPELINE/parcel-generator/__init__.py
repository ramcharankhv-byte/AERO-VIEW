"""Facade for parcel_generator."""
try:
    from .pipeline import generate_parcel_layer
except ImportError:
    from pipeline import generate_parcel_layer

__all__ = ["generate_parcel_layer"]

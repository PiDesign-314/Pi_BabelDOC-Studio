"""Relocatable CLI plus restoration of bundled fonts and layout assets."""
import sys
from pathlib import Path
from babeldoc.main import cli
if __name__ == '__main__':
    assets = Path(__file__).resolve().parents[1] / 'offline-assets'
    if assets.is_dir() and '--files' in sys.argv:
        from babeldoc.assets.assets import restore_offline_assets_package
        restore_offline_assets_package(assets)
    cli()

"""Install the BabelDOC Studio runtime guard at interpreter startup.

This directory is put on ``PYTHONPATH`` when the app launches BabelDOC, so
Python imports this module automatically before BabelDOC starts.  It stays tiny
and never raises: when the app did not ask for the guard it does nothing.
"""

import os


def _truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


if _truthy(os.environ.get("BABELDOC_STUDIO_GUARD")):
    try:
        import babeldoc_guard

        babeldoc_guard.install()
    except Exception:  # a guard failure must never break a translation
        pass

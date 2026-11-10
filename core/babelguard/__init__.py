"""Runtime guard for BabelDOC's empty / lost translations.

The app launches BabelDOC with this directory on ``PYTHONPATH`` and
``BABELDOC_STUDIO_GUARD=1``; ``sitecustomize.py`` then imports the sibling
:mod:`babeldoc_guard` module (not this package: the directory itself is the
import root) and installs the patches at interpreter startup.

See :mod:`babeldoc_guard` for the patch list and the status file contract.
"""

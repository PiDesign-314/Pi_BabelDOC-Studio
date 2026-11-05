"""Build Windows x64 ZIP from a full CPython installation (including Tcl/Tk).
Run with a clean Python 3.12 install. All writes stay under dist; never copies user data.
"""
import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependency-source', type=Path, help='Reuse an installed BabelDOC site-packages for an offline local build')
    parser.add_argument('--resume', action='store_true', help='Resume a failed build in the fixed dist folder')
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise SystemExit('Build on Windows x64 with Python 3.12')
    out = ROOT / 'dist' / 'BabelDOC-Studio-Windows-x64'
    if out.exists() and not args.resume:
        raise SystemExit(f'Build destination already exists: {out}; choose a fresh workspace')
    runtime = out / 'runtime'
    shutil.copytree(Path(sys.base_prefix), runtime, dirs_exist_ok=True, ignore=shutil.ignore_patterns('site-packages','__pycache__','Scripts','Doc','include','libs','test','tests'))
    packages = runtime / 'Lib' / 'site-packages'
    packages.mkdir(parents=True, exist_ok=True)
    python = str(runtime / 'python.exe')
    if args.dependency_source:
        shutil.copytree(args.dependency_source, packages, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
        requirements = ['Flask==3.1.3', 'PyMuPDF==1.28.2']
    else:
        requirements = ['-r', str(ROOT / 'requirements-portable.txt')]
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--target', str(packages), '--upgrade', *requirements], check=True)
    for folder in ('core','web','presets','tools'):
        shutil.copytree(ROOT / folder, out / folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
    for name in ('app.py','README.md','requirements-portable.txt','BabelDOC-Studio-app-icon.svg'):
        shutil.copy2(ROOT / name, out / name)
    (out / 'Start.bat').write_text('@echo off\nsetlocal\ncd /d "%~dp0"\nset PYTHONHOME=\nset PYTHONPATH=\nstart "" "%~dp0runtime\\pythonw.exe" -s "%~dp0app.py"\n', encoding='ascii')
    subprocess.run([python, '-s', '-c', 'import flask,pymupdf,tkinter,onnxruntime; import babeldoc.main; import app; assert app.app.test_client().get("/").status_code==200'], cwd=out, check=True)
    subprocess.run([python, '-s', str(out/'tools'/'babeldoc_cli.py'), '--version'], check=True)
    # Generate all required model/font assets with upstream's supported mechanism.
    assets = out / 'offline-assets'
    assets.mkdir(exist_ok=True)
    subprocess.run([python, '-s', str(out/'tools'/'babeldoc_cli.py'), '--generate-offline-assets', str(assets)], check=True)
    with (out/'DEPENDENCIES.txt').open('w',encoding='utf-8') as handle:
        subprocess.run([sys.executable,'-m','pip','list','--path',str(packages),'--format=freeze'],stdout=handle,check=True)
    archive = Path(shutil.make_archive(str(out),'zip',out.parent,out.name))
    digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n',encoding='ascii')
    print(archive)

if __name__ == '__main__':
    main()

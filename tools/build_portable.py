"""Build Windows x64 ZIP from a full CPython installation (including Tcl/Tk).
Run with a clean Python 3.12 install. All writes stay under dist; never copies user data.

The ZIP contains 390 exe/dll/pyd (375 of them unsigned by default). Windows 11 Smart App
Control blocks unsigned binaries, so add --sign (with code-signing credentials configured)
for a release build; see docs/SMART-APP-CONTROL.md.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIGN_SCRIPT = ROOT / 'tools' / 'sign_release.ps1'

# Start.bat 是脚本，没法签名；这里让它首次运行时自己清掉整个目录的「来自 Internet」标记
# （等价于右键 → 属性 → 解除锁定），之后用 .babeldoc-unblocked 标记跳过，避免每次启动都扫描。
START_BAT = '''@echo off
setlocal
cd /d "%~dp0"
set PYTHONHOME=
set PYTHONPATH=
if not exist "%~dp0.babeldoc-unblocked" (
  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File; Set-Content -LiteralPath '%~dp0.babeldoc-unblocked' -Value 'unblocked' -Encoding ascii" >nul 2>nul
)
start "" "%~dp0runtime\\pythonw.exe" -s "%~dp0app.py"
'''


def _find_csc():
    """Locate the .NET Framework C# compiler shipped with Windows."""
    windir = Path(os.environ.get('WINDIR', r'C:\Windows'))
    for arch in ('Framework64', 'Framework'):
        candidate = windir / 'Microsoft.NET' / arch / 'v4.0.30319' / 'csc.exe'
        if candidate.exists():
            return candidate
    return None


def _build_launcher(out):
    """Compile BabelDOC Studio.exe, a signable entry point for the portable package."""
    source = ROOT / 'tools' / 'launcher' / 'Launcher.cs'
    if not source.exists():
        print('警告: 找不到 tools/launcher/Launcher.cs，跳过 BabelDOC Studio.exe 启动器。')
        return
    csc = _find_csc()
    if not csc:
        print('警告: 找不到 .NET Framework 的 csc.exe，跳过 BabelDOC Studio.exe 启动器；Start.bat 仍可使用。')
        return
    framework = csc.parent
    command = [
        str(csc), '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
        f'/out:{out / "BabelDOC Studio.exe"}',
        f'/r:{framework / "System.dll"}',
        f'/r:{framework / "System.Windows.Forms.dll"}',
    ]
    icon = out / 'web' / 'babeldoc.ico'
    if icon.exists():
        command.append(f'/win32icon:{icon}')
    command.append(str(source))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        print('警告: 启动器编译失败，继续使用 Start.bat。')
        print(result.stdout[-2000:])
        print(result.stderr[-2000:])
        return
    print('已生成启动器：BabelDOC Studio.exe')


def _powershell_script(*arguments):
    subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SIGN_SCRIPT),
         *[str(argument) for argument in arguments]],
        check=True,
    )


def _signature_status(path):
    """Return the Authenticode status of one file (Windows only)."""
    result = subprocess.run(
        ['powershell', '-NoProfile', '-Command',
         f"(Get-AuthenticodeSignature -LiteralPath '{path}').Status"],
        capture_output=True, text=True,
    )
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependency-source', type=Path, help='Reuse an installed BabelDOC site-packages for an offline local build')
    parser.add_argument('--resume', action='store_true', help='Resume a failed build in the fixed dist folder')
    parser.add_argument('--sign', action='store_true', help='Sign all exe/dll/pyd before zipping (needs SIGN_CERT_THUMBPRINT or SIGN_PFX_PATH)')
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
    for name in ('app.py','README.md','CHANGELOG.md','requirements-portable.txt','BabelDOC-Studio-app-icon.svg','使用说明.txt','启动失败看这里.txt'):
        shutil.copy2(ROOT / name, out / name)
    (out / 'Start.bat').write_text(START_BAT, encoding='ascii', newline='\r\n')
    _build_launcher(out)
    if _signature_status(runtime / 'python.exe') != 'Valid':
        print('警告: runtime/python.exe 没有 Authenticode 签名（常见于 uv / python-build-standalone 的 CPython）。\n'
              '      Windows 11 智能应用控制会拦截未签名的 exe；发布版建议用 python.org 的 CPython 构建，并配合 --sign。\n'
              '      详见 docs/SMART-APP-CONTROL.md。')
    subprocess.run([python, '-s', '-c', 'import flask,pymupdf,tkinter,onnxruntime; import babeldoc.main; import app; assert app.app.test_client().get("/").status_code==200'], cwd=out, check=True)
    subprocess.run([python, '-s', str(out/'tools'/'babeldoc_cli.py'), '--version'], check=True)
    # Generate all required model/font assets with upstream's supported mechanism.
    assets = out / 'offline-assets'
    assets.mkdir(exist_ok=True)
    subprocess.run([python, '-s', str(out/'tools'/'babeldoc_cli.py'), '--generate-offline-assets', str(assets)], check=True)
    with (out/'DEPENDENCIES.txt').open('w',encoding='utf-8') as handle:
        subprocess.run([sys.executable,'-m','pip','list','--path',str(packages),'--format=freeze'],stdout=handle,check=True)
    # Signing must happen before zipping: it rewrites the exe/dll/pyd in place.
    if args.sign:
        print('签名全部 exe / dll / pyd ...')
        _powershell_script('-Path', out, '-Mode', 'Sign')
    else:
        _powershell_script('-Path', out, '-Mode', 'Audit')
        print('提示: 这是未签名构建；Windows 11 智能应用控制开启时会拦截，详见 docs/SMART-APP-CONTROL.md。')
    archive = Path(shutil.make_archive(str(out),'zip',out.parent,out.name))
    digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n',encoding='ascii')
    print(archive)

if __name__ == '__main__':
    main()

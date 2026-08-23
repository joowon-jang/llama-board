@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
where cl.exe
where link.exe
"C:\Users\joojoo\.cargo\bin\cargo.exe" check --manifest-path "C:\Users\joojoo\llama-command-builder\src-tauri\Cargo.toml"
exit /b %errorlevel%

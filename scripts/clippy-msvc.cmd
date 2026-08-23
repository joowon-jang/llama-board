@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
"C:\Users\joojoo\.cargo\bin\cargo.exe" clippy --manifest-path "C:\Users\joojoo\llama-command-builder\src-tauri\Cargo.toml" --all-targets --all-features -- -D warnings
exit /b %errorlevel%

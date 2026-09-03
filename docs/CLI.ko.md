# CLI

> **언어:** [English](CLI.md) | [한국어](CLI.ko.md) | [日本語](CLI.ja.md) | [中文](CLI.zh.md)

개발 중 `llama-board-cli.exe`는 `src-tauri/target/release/llama-board-cli.exe`에 생성됩니다. 패키지 빌드에서는 Tauri 리소스로 포함되므로 설치 후 앱의 리소스 디렉터리에서 찾을 수 있습니다. 출력은 JSON이며 서버는 루프백 전용이고 인증 정보는 저장하지 않습니다.

```powershell
./llama-board-cli.exe --help
./llama-board-cli.exe config get
./llama-board-cli.exe config set <field> <value>
./llama-board-cli.exe models list
./llama-board-cli.exe models delete <path>
./llama-board-cli.exe runtime list   # `runtimes`도 별칭으로 사용 가능
./llama-board-cli.exe runtime device
./llama-board-cli.exe runtime probe <backend> <build>
./llama-board-cli.exe server start   # 루프백, headless 모드에서는 API-key 인증을 사용하지 않음
./llama-board-cli.exe server status
./llama-board-cli.exe server logs [lines]
./llama-board-cli.exe server stop
./llama-board-cli.exe server unload  # stop의 별칭
./llama-board-cli.exe server restart
./llama-board-cli.exe doctor
```

## 처음 시작하기

headless 서버를 시작하기 전에 모델을 설정하세요. 서버 실행 파일은 선택한 관리형 런타임 또는 `PATH`에서 찾습니다.

```powershell
./llama-board-cli.exe config set models_dir "C:\Models"
./llama-board-cli.exe config set active_model "C:\Models\model.gguf"
./llama-board-cli.exe server start
```

- `config set`은 자격 증명과 알 수 없는 필드를 거부합니다.
- `config get`은 자격 증명처럼 보이는 값을 가립니다. `server_args`, `chat_options`, `lora_adapters`는 설정 시 JSON 값이 필요합니다.
- `models delete`는 `models_dir` 내부의 비활성 `.gguf`/`.mmproj` 파일만 삭제할 수 있습니다.
- `runtime device`는 로컬 GPU와 권장 백엔드를 검색하고, `runtime probe`는 버전/help/device/bench 사전 점검을 실행합니다.
- `server start`는 설정된 모델을 사용하고 `127.0.0.1`에 바인딩하며 API-key 인증을 의도적으로 끕니다. 신뢰할 수 있는 컴퓨터에서만 사용하고 포트를 외부에 노출하거나 전달하지 마세요.
- 표준 출력은 JSON이며 서버 로그 크기는 제한됩니다.

[SECURITY.ko.md](../SECURITY.ko.md)에서 인증 및 프로세스 경계를 확인하세요.

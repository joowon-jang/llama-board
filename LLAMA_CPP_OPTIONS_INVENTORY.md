# llama.cpp 옵션 인벤토리 및 llama-board 튜닝 구현 분석 (초안)

- 조사일: 2026-09-01 (Asia/Seoul)
- 대상 앱: llama-board 현재 워크스페이스
- upstream 기준: 조사 시점의 ggml-org/llama.cpp master에 있는 tools/server/README.md의 자동 생성 llama-server --help와 tools/server/server-schema.cpp
- 주의: llama.cpp 옵션은 빌드/커밋에 따라 바뀐다. 실제로 설치된 바이너리의 llama-server.exe --help와 --version을 최종 기준으로 삼아야 한다.

## 0. 결론 요약

현재 llama-board는 “전용 UI가 노출한 안전한 subset + 문자열 기반 llama-server CLI escape hatch + JSON 기반 /v1/chat/completions escape hatch” 구조다. 따라서 앱 업데이트 없이 미래 옵션을 전달할 수 있다는 README의 주장은 구조적으로 맞지만, raw 입력은 옵션 이름·타입을 정적으로 검증하지 않으므로 지원 여부와 런타임 오류는 선택한 llama.cpp 빌드가 결정한다.

| 조작 경로 | 저장 위치 | 실제 적용 시점 | 현재 범위 |
| --- | --- | --- | --- |
| Tuning의 Server/Reasoning/Speculative | AppConfig 전용 필드 | llama-server 재시작 | GPU layer, context, MoE/CPU threads, slots, timeout, idle sleep, speculative 기본값, reasoning, mmproj 등 |
| Tuning의 Sampling | AppConfig.chat_options 중 일부 + 전용 temperature/top_p/top_k | 다음 요청 | temperature/top-p/top-k 및 advanced sampling 필드 |
| Additional llama-server arguments | AppConfig.server_args: string[] | 재시작 | 현재 빌드가 아는 모든 CLI 옵션(단, 앱 관리 옵션 일부는 차단) |
| Advanced chat options | AppConfig.chat_options: JSON object | 다음 요청 | 현재 빌드가 아는 모든 completion/chat request 필드(단, model/messages/stream은 차단) |
| Execution/Model Profiles, Projects | localStorage/project JSON | 프로필 적용 시 | 위 전용 필드와 raw escape hatch를 복사하며, system prompt/stop strings 등 앱 레벨 값도 포함 |
| lifecycle/runtime | Rust 상태 + 관리형 runtime | 즉시 또는 다음 start | stop/start/unload, watchdog, runtime/backend/build 선택, API key, loopback host 등; llama.cpp inference option과 구분 |

가장 먼저 확인할 구현 이슈는 두 가지다.

1. CLI는 --mirostat-lr/--mirostat-ent를 쓰지만 현재 request schema는 mirostat_eta/mirostat_tau를 쓴다. UI advanced key가 mirostat_lr/mirostat_ent이므로, 이 값은 raw CLI로 넣을 때와 JSON request로 넣을 때 이름을 변환해야 한다.
2. 앱 관리 목록이 --parallel, --timeout, --sleep-idle-seconds, LoRA 관련 플래그 등을 모두 차단하지 않는다. 특히 Qwen preset은 --parallel 1을 raw args에 넣으면서 전용 parallel 필드도 존재하므로, duplicate option의 최종 우선순위가 빌드/파서에 의존할 수 있다.

## 1. 적용 경로와 우선순위

### 1.1 서버 시작 경로

Rust src-tauri/src/server.rs의 build_args가 다음 순서로 argv를 구성한다.

~~~
--model <active_model>
--host 127.0.0.1
--port <port>
--n-gpu-layers <ngl>
--ctx-size <ctx_size>
--flash-attn <flash_attn>
[--mmproj <mmproj>]
[--parallel <parallel>]             # parallel > 0일 때
[--timeout <seconds>]               # 기본 3600이 아닐 때
[--sleep-idle-seconds <seconds>]    # -1이 아닐 때
[--lora / --lora-scaled ...]
[--n-cpu-moe <n>]
[--threads <n>]
[speculative dedicated flags]
[reasoning dedicated flags]
--cont-batching                       # raw args로 명시하지 않은 경우
--no-webui                            # raw args로 명시하지 않은 경우
<cfg.server_args>                     # 마지막에 그대로 append
~~~

실행은 shell 문자열이 아닌 argv vector로 이루어지며, server_args의 한 줄이 한 프로세스 인자다. 따라서 &&, pipe, redirection 같은 shell 문법은 실행되지 않고, --flag=value 또는 flag/value를 별도 줄로 넣는 형태만 의미가 있다. API key는 앱이 임시 파일을 만들고 --api-key-file로 붙인다.

AppConfig는 start 전에 normalize/validate된다. 모델·projector·활성 LoRA가 .gguf인지, DFlash에 필요한 draft model/runtime인지, 선택한 runtime이 --mmproj, --lora, --lora-scaled를 지원하는지 probe한다. 서버는 loopback에만 bind되며 start 후 /health와 /v1/models를 기다린다.

### 1.2 채팅 요청 경로

src/panels/useChatSend.ts는 대화 history를 context의 약 75% 안으로 줄이고 capMaxTokens로 chat_options.max_tokens를 prompt 길이에 맞춰 복사본에서 상한 조정한다. 이후 src/api.ts의 buildChatRequestBody가 다음과 같이 merge한다.

~~~
{ ...sampling.options,                 # chat_options: arbitrary JSON
  model, messages, stream: true,       # app-owned, options로 덮을 수 없음
  temperature, top_p, top_k,           # 전용 sampling 값
  tools: ...                           # tool loop 사용 시
}
~~~

Reasoning effort가 default가 아니면 reasoning_effort를 넣고, chat_template_kwargs object는 기존 값과 merge한다. reasoning이 off이면 request effort를 none으로 바꾸고 enable_thinking=false를 넣으며, 그 외에는 enable_thinking=true를 넣는다. 따라서 chat_options에는 llama.cpp가 이해하는 임의 필드를 넣을 수 있지만 model, messages, stream, 전용 temperature/top-p/top-k, tools는 앱 값이 우선한다.

Sampling 변경은 저장 즉시 다음 메시지에 반영되고, server/reasoning/speculative/mmproj 변경은 Apply & restart가 필요하다. 서버가 꺼져 있으면 설정만 저장하고 다음 start에 적용한다.

## 2. 현재 llama-board 전용 옵션 인벤토리

### 2.1 AppConfig와 서버 시작 옵션

기본값과 범위는 src-tauri/src/config.rs, 전용 UI 필드와 hint는 src/panels/tuningFields.ts, argv 변환은 src-tauri/src/server.rs를 기준으로 추출했다.

| AppConfig key | CLI/동작 | 전용 UI | 기본값 또는 앱 제한 | 적용/비고 |
| --- | --- | --- | --- | --- |
| active_model | --model | Models/프로필 | 비어 있으면 start 불가; .gguf | 앱이 모델 경로를 소유 |
| port | --port | 앱 설정 | 8080 | --port, -p raw override 차단; host는 항상 127.0.0.1 |
| ngl | --n-gpu-layers | Server | 0..128, 기본 0 | upstream은 exact/auto/all을 지원하지만 전용 필드는 숫자만 보존 |
| ctx_size | --ctx-size | Server | 512..131072, 기본 4096 | memory estimate와 max_tokens cap에도 사용 |
| flash_attn | --flash-attn | Server | auto/on/off, 기본 auto | restart 필요 |
| n_cpu_moe | --n-cpu-moe | Server | 0..64, 기본 0 | 0이면 flag 생략 |
| threads | --threads | Server | 0..64, 기본 0 | 0이면 llama-server 기본값 사용 |
| parallel | --parallel | Server | 0..128, 기본 0 | 0이면 flag 생략/llama-server auto; slots마다 KV memory 증가 |
| request_timeout_seconds | --timeout | Server | 1..86400, 기본 3600 | 기본값이면 flag 생략 |
| sleep_idle_seconds | --sleep-idle-seconds + board watchdog | Server/lifecycle | -1..604800, 기본 -1 | llama-server의 sleep과 board의 idle unload 판단이 같은 설정을 공유하므로 의미를 분리해 표시할 필요가 있음 |
| mmproj | --mmproj | Server | 빈 문자열 또는 .gguf/.mmproj | URL/auto/offload/device 전용 필드는 없음; raw --mmproj-url, --mmproj-auto는 차단 |
| spec_type | --spec-type | Speculative | none 또는 custom string | UI named values: none, draft-simple, draft-eagle3, draft-mtp, draft-dflash, draft-dspark, ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache; 쉼표 조합도 허용 |
| spec_draft_model | --spec-draft-model | Speculative | 빈 문자열 또는 .gguf | DFlash 등 일부 type에서 필수 |
| spec_draft_ngl | --spec-draft-ngl | Speculative | auto, all, custom | raw numeric도 허용 |
| spec_draft_device | --spec-draft-device | Speculative | 빈 문자열 | 장치 이름/목록을 raw string으로 전달 |
| spec_draft_n_max | --spec-draft-n-max | Speculative | 0..64, 기본 3 | 값이 기본과 다를 때만 argv에 추가 |
| spec_draft_n_min | --spec-draft-n-min | Speculative | 0..64, 기본 0 | 동일 |
| spec_draft_p_min | --spec-draft-p-min | Speculative | 0..1, 기본 0 | 동일 |
| spec_draft_p_split | --spec-draft-p-split | Speculative | 0..1, 기본 .1 | 동일 |
| reasoning | --reasoning | Reasoning | auto/on/off, 기본 auto | raw CLI와 request effort/kwargs를 별도로 처리 |
| reasoning_format | --reasoning-format | Reasoning | auto/none/deepseek/deepseek-legacy | restart 필요 |
| reasoning_effort | --reasoning-effort + request reasoning_effort | Reasoning/Model profile | default/none/minimal/low/medium/high/xhigh/max | default/none은 CLI flag를 생략하고 none은 per-request로 처리 |
| reasoning_budget | --reasoning-budget | Reasoning | -1..1048576, 기본 -1 | request schema의 reasoning_budget_tokens와 별개 |
| reasoning_budget_message | --reasoning-budget-message | Reasoning | 빈 문자열 | restart 필요 |
| reasoning_preserve | --reasoning-preserve/--no-reasoning-preserve | Reasoning | auto/on/off | auto는 flag 생략 |
| lora_adapters[] | --lora 또는 --lora-scaled | runtime/config; 직접 Tuning section은 제한적 | path, scale 0..4, enabled | scale=1 adapter는 --lora, 그 외는 --lora-scaled; enabled paths를 comma-join |
| server_args[] | 그대로 argv append | Escape | 최대 512 args, arg당 32768 bytes, 총 131072 bytes | 차단 목록 외에 option schema 검증 없음 |

정규화는 잘못된 값에 기본값/경계값을 적용한다. port=0은 8080, ngl/n_cpu_moe/threads/parallel은 음수 0, context/temperature/top-p/top-k/timeout/idle 등은 정의된 범위로 clamp되고, reasoning/spec 문자열은 허용 enum으로 제한된다. 설정 파일의 migration version은 현재 7이다.

### 2.2 AppConfig에 있지만 llama.cpp inference option은 아닌 값

다음 값도 소스에서 조작할 수 있지만 llama.cpp 모델 계산 파라미터와 분리해서 문서화해야 한다.

| key/영역 | 역할 | llama.cpp와의 관계 |
| --- | --- | --- |
| config_version | 설정 migration version | 앱 내부 metadata |
| models_dir | 모델 검색/목록 기본 디렉터리 | 현재 canonical argv에는 --models-dir로 자동 전달하지 않음; upstream router의 raw flag와 별개 |
| active_backend, active_build | managed runtime/backend/build 선택 | 실행할 바이너리 선택 |
| iters | benchmark 반복 횟수 | llama-bench 호출용 |
| api key | start 때 생성하고 임시 파일로 전달 | 사용자 AppConfig field가 아니라 앱 보안 상태 |
| system_prompt | Model Profile/Project의 초기 system message | chat messages에 들어가는 앱 동작 |
| stop_strings | Model Profile의 stop list | request stop으로 변환 |
| document/MCP/project metadata | Projects의 첨부/검색/MCP 설정 | client-side tool loop 또는 project behavior |

위 값들은 Tuning 화면에서 server-side llama.cpp 옵션으로 표시하지 않는 것이 좋다. 특히 system_prompt, stop_strings, project document context는 upstream CLI flag가 아니라 요청을 만드는 앱 레이어다.

### 2.3 전용 UI의 per-request sampling

전용 입력은 temperature(0..2, 기본 .8), top_p(.01..1, 기본 .95), top_k(1..200, 기본 40)이다. 값은 sampling object로 /v1/chat/completions에 매 요청 들어간다. upstream request schema는 temperature를 무한대까지, top-k를 0(비활성)까지 허용하므로 앱 UI 범위가 의도적으로 더 좁다.

Tuning의 Advanced sampling과 Execution Profile에서 편집 가능한 key는 다음과 같다. 값이 chat_options에 없으면 아래 default를 표시하고, 입력하면 JSON number로 저장한다.

~~~
min_p                 default 0.05
top_n_sigma           default -1
typical_p             default 1
xtc_probability       default 0
xtc_threshold         default 0.1
dynatemp_range        default 0
dynatemp_exponent     default 1
repeat_last_n         default 64
repeat_penalty        default 1
presence_penalty      default 0
frequency_penalty     default 0
dry_multiplier        default 0
dry_base              default 1.75
dry_allowed_length    default 2
dry_penalty_last_n    default 64
mirostat              default 0 (0/1/2)
mirostat_lr           default 0.1  # CLI 명칭; request schema는 mirostat_eta
mirostat_ent          default 5    # CLI 명칭; request schema는 mirostat_tau
seed                  default -1
max_tokens            default -1  # n_predict alias; 전송 직전 context cap 가능
n_probs               default 0
min_keep              default 0
t_max_predict_ms      default 0
id_slot               default -1
~~~

qwenDefaults.ts의 Qwen3.8 profile은 일반 기본값과 다르다.

~~~
Server: ngl=99, ctx_size=131072, flash_attn=on,
        spec_type=draft-mtp, spec_draft_n_max=5,
        spec_draft_ngl=all, reasoning=on,
        reasoning_format=deepseek, reasoning_effort=xhigh,
        reasoning_preserve=on
Chat:   min_p=0, repeat_penalty=1, presence_penalty=0,
        max_tokens=131072,
        chat_template_kwargs={enable_thinking:true,preserve_thinking:true}
Raw:    --batch-size 1024
        --ubatch-size 512
        --parallel 1
        --cache-type-k q8_0
        --cache-type-v q8_0
        --cache-ram 16384
        --ctx-checkpoints 32
        --cache-prompt
        --kv-unified
        --no-context-shift
        --jinja
        --spec-draft-type-k q8_0
        --spec-draft-type-v q8_0
        --spec-draft-backend-sampling
~~~

### 2.4 현재 generic request JSON으로 보낼 수 있는 항목

다음은 조사 시점 upstream server-schema.cpp에서 completion/chat task에 정의된 request-level field다. llama-board는 chat_options가 object이기만 하면 이 key를 전부 raw JSON으로 보낼 수 있다(서버가 해당 빌드에서 지원하는 경우).

#### stream/cache/response 및 context

~~~
verbose
timings_per_token
stream
stream_options.include_usage
cache_prompt
return_tokens
return_progress
sse_ping_interval
n_predict                 (aliases: max_completion_tokens, max_tokens)
n_indent
n_keep
n_discard
n_cmpl                    (alias: n)
n_cache_reuse
t_max_predict_ms
response_fields
~~~

#### sampling

~~~
top_k
top_p
min_p
top_n_sigma
xtc_probability
xtc_threshold
typical_p
temperature
dynatemp_range
dynatemp_exponent
repeat_last_n
repeat_penalty
frequency_penalty
presence_penalty
dry_multiplier
dry_base
dry_allowed_length
dry_penalty_last_n
mirostat
mirostat_tau              # request 이름
mirostat_eta              # request 이름
adaptive_target
adaptive_decay
seed
n_probs                   (alias: logprobs)
min_keep
backend_sampling
post_sampling_probs
~~~

#### speculative/adapters/grammar

~~~
lora                      # [{"id": number, "scale": number}, ...]
dry_sequence_breakers     # non-empty array of strings
json_schema               # json_schema가 grammar보다 우선
grammar                   # GBNF string alias path
grammar_lazy
~~~

현재 upstream schema의 speculative request override block은 #if 0으로 비활성화되어 있다. 따라서 다음 이름은 문서/소스에 보이지만 현재 request JSON으로 조절 가능한 것으로 분류하면 안 된다.

~~~
speculative.n_max
speculative.n_min
speculative.p_min
speculative.type
speculative.ngram_size_n
speculative.ngram_size_m
speculative.ngram_min_hits
~~~

#### chat parser/reasoning/token-level

~~~
chat_format
reasoning_format
generation_prompt
parse_tool_calls
chat_parser
continue_final_message
echo
preserved_tokens
grammar_triggers
reasoning_control
reasoning_budget_tokens
reasoning_budget_start_tag
reasoning_budget_end_tags  (alias: reasoning_budget_end_tag)
reasoning_budget_message
logit_bias
ignore_eos
stop
samplers
~~~

추가로 llama-board의 Qwen preset은 chat_template_kwargs를 request JSON에 넣는다. 이것은 generic spread로 전달되지만 조사한 current server-schema.cpp의 make_llama_cmpl_schema field 목록에는 직접 정의되어 있지 않다. 사용하는 chat template/parser가 해당 kwargs를 지원하는지 모델/runtime별 검증이 필요하다.

### 2.5 차단 및 보안 경계

src/panels/tuningValidation.ts와 src-tauri/src/config.rs가 공통으로 app-managed CLI override를 차단한다.

~~~
--model, -m
--host
--port, -p
--api-key, --api-key-file, --no-api-key
--mmproj, -mm, --mmproj-url, --mmproj-auto, --no-mmproj, --no-mmproj-auto
--n-gpu-layers, -ngl
--ctx-size, -c
--flash-attn
--n-cpu-moe, -ncmoe
--threads, -t
--spec-type
--spec-draft-n-max, --spec-draft-n-min
--spec-draft-p-min, --spec-draft-p-split
--spec-draft-ngl, --spec-draft-device, --spec-draft-model
--reasoning, --reasoning-format, --reasoning-effort
--reasoning-budget, --reasoning-budget-message
--reasoning-preserve, --no-reasoning-preserve
~~~

chat_options는 model, messages, stream key만 reserved로 차단한다. JSON object 자체는 최대 262144 bytes이며, nested value의 llama.cpp 의미/타입은 서버가 검사한다. server_args는 개수/문자열 길이/NUL/총 bytes 제한과 위 reserved option 검사만 하므로, 오타·미지원 option은 start 시 llama-server 오류로 드러난다.

검토 필요 항목은 다음과 같다.

| 상태 | 항목 | 이유 |
| --- | --- | --- |
| 높은 우선순위 | --parallel | 전용 parallel도 있고 raw args 차단 목록에는 없다. Qwen preset이 동일 flag를 raw args에 포함한다. duplicate가 허용되는지/마지막 값 우선인지 build별 차이가 날 수 있다. |
| 높은 우선순위 | --timeout, --sleep-idle-seconds | 전용 server/lifecycle 필드와 raw override가 동시에 가능하다. 사용자가 raw 값으로 board UI 표시값과 실제 값의 불일치를 만들 수 있다. |
| 높은 우선순위 | --lora, --lora-scaled | AppConfig의 enabled adapters와 raw 값이 중복될 수 있다. request-level lora도 별도 존재한다. |
| 높은 우선순위 | builder가 인식하는 alias | build_args의 cont-batching/webui duplicate 검사는 --cont-batching/--no-cont-batching 및 --webui/--no-webui만 본다. raw -cb/-nocb 또는 --ui/--no-ui를 넣으면 앱이 반대/중복 flag를 추가할 수 있다. |
| 중간 | short alias/alternate alias | 차단 목록이 canonical long name 중심이므로 -fa, --gpu-layers, --reasoning의 -rea, draft의 --draft-p-min/--draft-p-split 같은 alias가 전용 field와 충돌할 수 있다. upstream에 새 alias가 생기면 bypass 가능성이 더 커진다. |
| 중간 | request schema validation | arbitrary JSON은 어떤 키/타입도 저장하므로 UI에서 성공해도 실제 request가 400/무시될 수 있다. |

## 3. upstream llama-server 전체 CLI 인벤토리

아래는 조사 시점 official README의 자동 생성 help block에 등장하는 모든 option을 category별로 묶은 것이다. 같은 줄의 slash는 같은 기능의 alias 또는 on/off pair이며, argument placeholder는 생략했다. removed는 help에는 남아 있으나 현재 사용하면 안 되는 호환 안내이고, preset은 모델별 convenience preset이다.

upstream 문서에 함께 표시되는 LLAMA_ARG_* 및 LLAMA_API_KEY 환경변수도 같은 parameter surface이지만, llama-board는 child process 환경을 정리하고 argv를 직접 구성하므로 사용자가 환경변수로 서버 설정을 주입하는 경로는 제공하지 않는다. 따라서 이 문서의 “현재 조작 가능”은 llama-board UI/config/argv/request를 통해 전달되는 경로를 뜻한다.

### 3.1 Common

~~~
-h, --help, --usage
--version
-cl, --cache-list
--completion-bash
~~~

### 3.2 CPU execution / scheduling

~~~
-t, --threads
-tb, --threads-batch
-C, --cpu-mask
-Cr, --cpu-range
--cpu-strict
--prio
--poll
-Cb, --cpu-mask-batch
-Crb, --cpu-range-batch
--cpu-strict-batch
--prio-batch
--poll-batch
~~~

### 3.3 Context, RoPE, KV, loading, offload, GPU, adapters

~~~
-c, --ctx-size
-n, --predict, --n-predict
-b, --batch-size
-ub, --ubatch-size
--keep
--swa-full
-fa, --flash-attn
--perf, --no-perf
-e, --escape, --no-escape
--rope-scaling
--rope-scale
--rope-freq-base
--rope-freq-scale
--yarn-orig-ctx
--yarn-ext-factor
--yarn-attn-factor
--yarn-beta-slow
--yarn-beta-fast
-kvo, --kv-offload, -nkvo, --no-kv-offload
--repack, -nr, --no-repack
--no-host
-ctk, --cache-type-k
-ctv, --cache-type-v
-dt, --defrag-thold
--rpc
--mlock
--mmap, --no-mmap
-dio, --direct-io, -ndio, --no-direct-io
-lm, --load-mode
-lzm, --lazy-mode
--numa
-dev, --device
--list-devices
-ot, --override-tensor
-cmoe, --cpu-moe
-ncmoe, --n-cpu-moe
-ncffn, --n-cpu-ffn
-ngl, --gpu-layers, --n-gpu-layers
-sm, --split-mode
-ts, --tensor-split
-mg, --main-gpu
-fit, --fit
-fitt, --fit-target
-fitc, --fit-ctx
--check-tensors
--override-kv
--op-offload, --no-op-offload
--lora
--lora-scaled
--control-vector
--control-vector-scaled
--control-vector-layer-range
~~~

upstream 의미상 --mlock, --mmap, --direct-io는 --load-mode로 대체되는 deprecated 계열이다. --ngl은 앱 전용 numeric ngl보다 넓게 exact/auto/all을 지원한다.

### 3.4 Model source / download

~~~
-m, --model
-mu, --model-url
-dr, --docker-repo
-hf, -hfr, --hf-repo
-hff, --hf-file
-hft, --hf-token
~~~

### 3.5 Logging / offline

~~~
--log-disable
--log-file
--log-colors
-v, --verbose, --log-verbose
--offline
-lv, --verbosity, --log-verbosity
--log-prefix, --no-log-prefix
--log-timestamps, --no-log-timestamps
~~~

### 3.6 Draft KV cache

~~~
--spec-draft-type-k, -ctkd, --cache-type-k-draft
--spec-draft-type-v, -ctvd, --cache-type-v-draft
~~~

### 3.7 Sampling CLI defaults

~~~
--samplers
-s, --seed
--sampler-seq, --sampling-seq
--ignore-eos
--temp, --temperature
--top-k
--top-p
--min-p
--top-nsigma, --top-n-sigma
--xtc-probability
--xtc-threshold
--typical, --typical-p
--repeat-last-n
--repeat-penalty
--presence-penalty
--frequency-penalty
--dry-multiplier
--dry-base
--dry-allowed-length
--dry-penalty-last-n
--dry-sequence-breaker
--adaptive-target
--adaptive-decay
--dynatemp-range
--dynatemp-exp
--mirostat
--mirostat-lr
--mirostat-ent
-l, --logit-bias
--grammar
--grammar-file
-j, --json-schema
-jf, --json-schema-file
-bs, --backend-sampling
~~~

### 3.8 Server, cache, multimodal, network, UI, security, gateway

~~~
-lcs, --lookup-cache-static
-lcd, --lookup-cache-dynamic
--kv-unified-per-slot
-ctxcp, --ctx-checkpoints, --swa-checkpoints
-cms, --checkpoint-min-step
-cram, --cache-ram
-kvu, --kv-unified, -no-kvu, --no-kv-unified
--cache-idle-slots, --no-cache-idle-slots
--context-shift, --no-context-shift
-r, --reverse-prompt
-sp, --special
--warmup, --no-warmup
--spm-infill
--pooling
-np, --parallel
-cb, --cont-batching, -nocb, --no-cont-batching
-mm, --mmproj
-mmu, --mmproj-url
--mmproj-auto, --no-mmproj, --no-mmproj-auto
--mmproj-offload, --no-mmproj-offload
-mmdev, --mmproj-device
--image-min-tokens
--image-max-tokens
--mtmd-batch-max-tokens
--video-fps
--video-timestamp-interval
--video-ffmpeg-dir
-a, --alias
--tags
--embd-normalize
--host
--port
--reuse-port
--path
--cors-origins
--cors-methods
--cors-headers
--cors-credentials, --no-cors-credentials
--api-prefix
--ui-config, --webui-config
--ui-config-file, --webui-config-file
--ui-mcp-proxy, --webui-mcp-proxy,
--no-ui-mcp-proxy, --no-webui-mcp-proxy
--tools
--tools-runtime
--mcp-servers-config
--mcp-servers-json
-ag, --agent, -no-ag, --no-agent
--ui, --webui, --no-ui, --no-webui
--embedding, --embeddings
--rerank, --reranking
--api-key
--api-key-file
--ssl-key-file
--ssl-cert-file
--chat-template-kwargs
-to, --timeout
--sse-ping-interval
--threads-http
--cache-prompt, --no-cache-prompt
--cache-reuse
--metrics
--props
--slots, --no-slots
--slot-save-path
--media-path
--models-dir
--models-preset
--models-max
--models-autoload, --no-models-autoload
--jinja, --no-jinja
--reasoning-format
-rea, --reasoning
--reasoning-effort
--reasoning-budget
--reasoning-budget-message
--reasoning-preserve, --no-reasoning-preserve
--chat-template
--chat-template-file
--skip-chat-parsing, --no-skip-chat-parsing
--prefill-assistant, --no-prefill-assistant
-sps, --slot-prompt-similarity
--lora-init-without-apply
--sleep-idle-seconds
--log-prompts-dir
~~~

세부 분류는 다음과 같다.

| 하위 영역 | 포함 옵션의 역할 |
| --- | --- |
| KV/checkpoint | lookup cache, per-slot limit, context checkpoints, checkpoint spacing, cache RAM, unified KV, idle slots, context shift |
| serving | parallel slots, continuous batching, timeout, HTTP threads, SSE ping, prompt cache/reuse |
| multimodal | mmproj 경로/URL/auto/offload/device, image token limits, MTMD batch, video FPS/timestamp/ffmpeg |
| API/network | alias/tags, host/port/reuse, static path, CORS, API prefix, SSL, API key |
| Web UI/agent/MCP | UI config, UI MCP proxy, tools, tools runtime, MCP config/JSON, agent, UI on/off |
| endpoint/runtime | embedding, rerank, metrics, props, slots, model router, media/slot save path, Jinja/template/reasoning |
| lifecycle/debug | warmup, slot similarity, LoRA init-only, idle sleep, prompt log directory |

### 3.9 Speculative draft model 및 n-gram

~~~
--spec-draft-hf, -hfd, -hfrd, --hf-repo-draft
--spec-draft-threads, -td, --threads-draft
--spec-draft-threads-batch, -tbd, --threads-batch-draft
--spec-draft-cpu-mask, -Cd, --cpu-mask-draft
--spec-draft-cpu-range, -Crd, --cpu-range-draft
--spec-draft-cpu-strict, --cpu-strict-draft
--spec-draft-prio, --prio-draft
--spec-draft-poll, --poll-draft
--spec-draft-cpu-mask-batch, -Cbd, --cpu-mask-batch-draft
--spec-draft-cpu-strict-batch, --cpu-strict-batch-draft
--spec-draft-prio-batch, --prio-batch-draft
--spec-draft-poll-batch, --poll-batch-draft
--spec-draft-override-tensor, -otd, --override-tensor-draft
--spec-draft-cpu-moe, -cmoed, --cpu-moe-draft
--spec-draft-n-cpu-moe, --spec-draft-ncmoe, -ncmoed, --n-cpu-moe-draft
--spec-draft-n-max
--spec-draft-n-min
--spec-synth-len
--spec-synth-rates
--spec-draft-p-split, --draft-p-split
--spec-draft-p-min, --draft-p-min
--spec-draft-backend-sampling, --no-spec-draft-backend-sampling
--spec-draft-device, -devd, --device-draft
--spec-draft-ngl, -ngld, --gpu-layers-draft, --n-gpu-layers-draft
--spec-draft-model, -md, --model-draft
--spec-type
--spec-ngram-mod-n-min
--spec-ngram-mod-n-max
--spec-ngram-mod-n-match
--spec-ngram-simple-size-n
--spec-ngram-simple-size-m
--spec-ngram-simple-min-hits
--spec-ngram-map-k-size-n
--spec-ngram-map-k-size-m
--spec-ngram-map-k-min-hits
--spec-ngram-map-k4v-size-n
--spec-ngram-map-k4v-size-m
--spec-ngram-map-k4v-min-hits
~~~

Draft-specific CPU/thread/device/cache controls는 현재 llama-board 전용 필드에 없다. raw args로는 모두 전달할 수 있다. --spec-synth-len과 --spec-synth-rates는 benchmarking-only 성격이므로 일반 채팅 profile UI에 노출할 필요가 낮다.

### 3.10 Removed/deprecated compatibility entries

~~~
--draft, --draft-n, --draft-max
--draft-min, --draft-n-min
--spec-ngram-size-n
--spec-ngram-size-m
--spec-ngram-min-hits
~~~

위 5개 entry는 현재 help에 “removed; 새 --spec-* option을 사용하라”는 안내로 남아 있다. 인벤토리에는 포함하되 새 설정 생성기/검증 enum에는 넣지 않는다.

### 3.11 Built-in presets

~~~
--embd-gemma-default
--fim-qwen-1.5b-default
--fim-qwen-3b-default
--fim-qwen-7b-default
--fim-qwen-7b-spec
--fim-qwen-14b-spec
--fim-qwen-30b-default
--gpt-oss-20b-default
--gpt-oss-120b-default
--vision-gemma-4b-default
--vision-gemma-12b-default
--spec-default
~~~

이 preset들은 모델 다운로드/기본 설정 편의 기능이며, llama-board의 Qwen3.8 profile과는 별도다.

## 4. upstream HTTP API 인벤토리와 현재 앱 coverage

### 4.1 upstream request schema

server-schema.cpp는 non-OAI /completion과 OAI chat/completions 계열에서 공통으로 평가되는 llama.cpp-specific field를 정의한다. OpenAI envelope인 model, messages, stream은 llama-board가 항상 만들며, raw chat_options에서는 reserved다.

| 영역 | 현재 request field | llama-board 경로 |
| --- | --- | --- |
| envelope | model, messages, stream | buildChatRequestBody가 생성; 사용자가 override 불가 |
| stream/cache | stream_options.include_usage, cache_prompt, return_tokens, return_progress, sse_ping_interval, timings_per_token, verbose, response_fields | chat_options JSON만 |
| token/context | n_predict/max_completion_tokens/max_tokens, n_indent, n_keep, n_discard, n_cmpl/n, n_cache_reuse, t_max_predict_ms | max_tokens, 나머지는 JSON |
| sampling | top-k/p/min-p, top-n-sigma, XTC, typical, temp/dynatemp, repetition/presence/frequency, DRY, Mirostat, adaptive-p, seed, n_probs/logprobs, min_keep | temperature/top-p/top-k/advanced UI + JSON |
| sampler chain | samplers, backend_sampling, post_sampling_probs | JSON |
| constraints | json_schema/grammar, grammar_lazy, logit_bias, ignore_eos, stop, dry_sequence_breakers | JSON; model profile stop strings는 stop으로 변환 |
| chat parser | chat_format, reasoning_format, generation_prompt, parse_tool_calls, chat_parser, continue_final_message, echo | JSON; 전용 reasoning format/effort도 별도 |
| token-level | preserved_tokens, grammar_triggers | JSON |
| reasoning budget | reasoning_control, reasoning_budget_tokens, start/end tags, reasoning_budget_message | JSON; server-side reasoning_budget와 구분 |
| adapter | lora: [{id, scale}] | JSON; startup LoRA paths는 전용 lora_adapters |
| speculative request override | source에 있으나 #if 0 | 현재 조작 불가로 분류 |

중요한 이름 매핑은 다음과 같다.

| 의미 | CLI | request JSON |
| --- | --- | --- |
| Mirostat learning rate | --mirostat-lr | mirostat_eta |
| Mirostat target entropy | --mirostat-ent | mirostat_tau |
| token budget | --reasoning-budget | reasoning_budget_tokens |
| output token limit | --predict/--n-predict (server default) | n_predict / max_completion_tokens / max_tokens |

현재 UI의 mirostat_lr/mirostat_ent는 CLI option명을 그대로 JSON key로 재사용한 형태라 request path에서 upstream schema와 일치하지 않는다. UI 저장 key를 유지할 경우 전송 직전에 mirostat_lr -> mirostat_eta, mirostat_ent -> mirostat_tau를 변환하거나, UI/config key를 request schema 이름으로 바꾸고 CLI builder에서 역변환해야 한다.

### 4.2 upstream endpoint family

llama-server에는 다음 endpoint family가 있다(일부는 동일 동작의 legacy/OAI alias). 정확한 route와 enabled 여부는 빌드의 server.cpp/--help를 확인한다.

| family | 예시 route | llama-board 현재 사용/노출 |
| --- | --- | --- |
| health | GET /health, /v1/health | Rust readiness polling |
| chat completion | POST /chat/completions, /v1/chat/completions | 기본 채팅이 /v1/chat/completions 사용 |
| completion | POST /completion, /completions, /v1/completions | 직접 호출 UI 없음 |
| responses | POST /responses, /v1/responses | 직접 호출 UI 없음 |
| Anthropic messages | POST /v1/messages | 앱 gateway가 loopback adapter로 제공; upstream route 직접 사용 아님 |
| embeddings | POST /embedding, /embeddings, /v1/embeddings | embedText가 /embeddings 사용 |
| rerank | POST /rerank, /reranking, /v1/rerank, /v1/reranking | 직접 UI 없음 |
| multimodal/audio | POST /v1/audio/transcriptions, /audio/transcriptions, plus multimodal chat/completion/embedding | mmproj 설정은 있으나 audio API client 없음 |
| token/template | POST /tokenize, /detokenize, /apply-template | 직접 UI 없음 |
| token count | /chat/completions/input_tokens, /v1/chat/completions/input_tokens, /responses/input_tokens, /v1/responses/input_tokens, /v1/messages/count_tokens | local token estimate 사용; 직접 API 호출 없음 |
| LoRA | GET/POST /lora-adapters | API helper 존재; startup config/probe와 별도 |
| slots | GET /slots, POST /slots/:id_slot | dedicated UI 없음; id_slot은 request JSON 가능 |
| monitoring/config | GET /metrics, /props, /models, /v1/models; POST /props | /v1/models 조회 및 status에 사용; metrics/props 직접 UI 없음 |
| router/model lifecycle | POST /models, /models/load, /models/unload, GET /models/sse, DELETE /models | 앱은 single-model child process를 Tauri lifecycle로 관리 |
| tools/MCP | tool discovery 및 Web UI/MCP 관련 routes | 앱 MCP tool loop는 client-side; server tools/MCP CLI는 raw args |

src/api.ts의 Native LM Studio adapter는 /api/v1/chat을 사용하고, Anthropic adapter는 gateway /v1/messages 형식을 사용한다. 이 두 adapter는 chat_options 전체를 llama.cpp request schema 그대로 전달하지 않는다. Native는 arbitrary options를 spread하되 app-owned fields가 뒤에서 override하고, Anthropic은 max_tokens, temperature/top-p/top-k/tools 등 일부만 추출한다. 따라서 full JSON escape hatch의 coverage는 기본 llama-server OpenAI route에서 가장 높다.

## 5. 카테고리 분류 초안

향후 Tuning UI와 문서의 stable category는 다음처럼 나누는 것이 적절하다.

| ID | 카테고리 | 대표 CLI | 현재 노출 | 제품화 제안 |
| --- | --- | --- | --- | --- |
| S1 | 모델 소스/식별 | model, model-url, HF/Docker, alias, tags, override-kv | 모델 선택 + raw | 경로/다운로드는 runtime 화면, metadata override는 advanced |
| S2 | 디바이스·offload | device, gpu layers, split/tensor split, main GPU, fit, op-offload, RPC | ngl, raw | device 목록을 probe 기반 select로 승격 |
| S3 | CPU 실행 | threads, threads-batch, CPU affinity/priority/poll | threads | 일반 threads와 batch threads 분리 후보 |
| S4 | context/배치 | ctx-size, batch-size, ubatch-size, keep, predict, SWA | ctx-size | batch/ubatch는 memory estimate와 묶은 advanced |
| S5 | RoPE/장기 context | rope/yarn 계열 | raw | 모델 metadata와 충돌하므로 expert-only |
| S6 | KV/cache | KV offload/type, cache RAM/reuse, unified, checkpoints, context shift | raw + Qwen preset | context/parallel과 함께 memory-impact section |
| S7 | sampling | temperature, top-k/p, min-p, typical, XTC, dynatemp, penalties, DRY, adaptive-p, Mirostat | 전용 + advanced | request schema 기반 typed editor; CLI/request 명칭 mapping 필요 |
| S8 | 출력 제약 | grammar/json-schema, logit-bias, stop, ignore-eos, grammar triggers | JSON + model stop strings | JSON editor와 예제 preset 제공 |
| S9 | reasoning/template | jinja, chat-template, chat parser, reasoning, effort/budget/preserve | reasoning 전용 + raw | server default와 per-request override를 한 화면에 표시 |
| S10 | speculative | spec type/draft model/device/ngl/n*, p*, draft cache/CPU/ngram | 일부 전용 + raw | draft target과 verification target을 구분하고 runtime capability 표시 |
| S11 | multimodal | mmproj, image/video/MTMD limits, mmproj offload | local mmproj | projector URL/auto/offload/device를 separate advanced로 추가 검토 |
| S12 | serving/slots | parallel, cont-batching, timeout, SSE, cache prompt, slot similarity | parallel/timeout/idle | app-managed duplicate 차단과 effective-value 표시 필요 |
| S13 | network/security | host/port, CORS, API key, SSL, API prefix | host/port/API key app-managed | loopback guarantee 유지; raw bypass 불가하게 aliases까지 차단 |
| S14 | observability/debug | logs, perf, metrics, props, slots, prompt logs | status/log tail + raw | 위험한 logging/path 옵션은 explicit warning |
| S15 | tools/MCP/router | tools, tools-runtime, MCP config, agent, model router | client MCP + raw | untrusted environment warning 필수; 기본 UI에 숨김 |
| A1 | llama-board lifecycle | stop/start/unload, sleep watchdog, memory estimate, runtime probe | 전용 lifecycle | llama.cpp 옵션과 같은 카드에 두지 않고 앱 lifecycle로 분리 |
| A2 | app profile | system prompt, stop_strings, project metadata, active backend/build, benchmark iters | Profiles/Projects | upstream 옵션이 아닌 app behavior로 명시 |

전용 UI → typed advanced → raw escape hatch 3단계가 사용자 경험과 forward compatibility의 균형점이다. raw escape hatch를 없애기보다, typed editor에 추가할 때 동일 key의 CLI/request 매핑과 적용 시점을 명시하는 방식이 안전하다.

## 6. 구현상 누락·불일치 및 권장 후속 작업

### P0: request key mapping 수정

mirostat_lr/mirostat_ent를 request body에 그대로 보내지 않도록 한다. 가장 작은 변경은 buildChatRequestBody 직전에 chat_options를 shallow-copy하고 다음을 수행하는 것이다.

~~~
mirostat_lr -> mirostat_eta
mirostat_ent -> mirostat_tau
~~~

동시에 동일 의미의 두 key가 user JSON에 함께 있을 때 우선순위를 문서화하고, server-schema 기반 request smoke test를 추가한다. CLI server_args에는 기존 --mirostat-lr/--mirostat-ent를 그대로 유지한다.

### P1: app-managed collision 방지

다음 옵션을 canonical name과 모든 현재 alias로 reserved 목록에 넣거나, raw args를 argv builder가 typed field로 합쳐 duplicate를 거부한다. reserved 검사는 문자열 exact match가 아니라 upstream option alias를 canonical name으로 먼저 정규화해야 한다.

~~~
--parallel / -np
--timeout / -to
--sleep-idle-seconds
--lora / --lora-scaled
--cont-batching / -cb / --no-cont-batching / -nocb
--webui / --ui / --no-webui / --no-ui
--flash-attn / -fa
--n-gpu-layers / --gpu-layers / -ngl
--reasoning / -rea
--spec-draft-p-split / --draft-p-split
--spec-draft-p-min / --draft-p-min
--spec-draft-ngl / --gpu-layers-draft / --n-gpu-layers-draft
~~~

--mmproj-url, --mmproj-auto를 현재 차단한 정책은 앱이 local mmproj만 지원한다는 뜻이므로 유지 가능하다. 다만 차단 메시지에 “현재 전용 UI가 local projector만 지원”을 명시하면 사용자가 막힌 이유를 이해하기 쉽다.

### P1: 범위와 effective value 표시

전용 field의 app clamp와 upstream 허용 범위를 같이 표시한다. 특히 ngl의 auto/all, top-k 0, top-p 0, temperature >2, ctx-size=0(모델 metadata) 같은 upstream 값은 현재 UI에서 손실되거나 입력 불가하다. 앱 범위를 의도적으로 제한한다면 “앱 안전 범위”라고 표시하고, unrestricted 값은 raw escape hatch로 안내한다.

### P2: schema-driven JSON editor

현재 chat_options는 arbitrary JSON이므로 typo와 route별 unsupported field를 저장할 수 있다. upstream schema의 field/type/range/alias를 versioned manifest로 가져오고, 다음 상태를 구분하는 것이 좋다.

~~~
known + validated       # typed control 또는 schema validator 통과
known + route-specific  # completion/chat/response 차이
unknown                 # raw forward, warning
disabled-in-source      # speculative request block처럼 #if 0
app-reserved            # model/messages/stream
~~~

### P2: runtime inventory 자동 수집

managed runtime 설치/선택 시 llama-server --help와 --version 결과를 저장하고, 현재 build가 실제로 지원하는 CLI set을 UI에 표시한다. upstream master를 기준으로 만든 static 목록은 참고용이며, PR/custom build에서는 static list가 틀릴 수 있다.

### P3: API coverage 확장

사용자 요구가 생길 경우 다음 adapter를 별도 기능으로 추가한다.

~~~
tokenize/detokenize/apply-template
direct /v1/responses
embedding/rerank options
slots save/load 및 id_slot 관리
metrics/props/slots diagnostics
audio transcription
multimodal content helper
~~~

각 endpoint의 request schema는 공통 completion schema와 같다고 가정하지 말고 route별로 검증해야 한다. 특히 Anthropic/Native adapter는 현재 arbitrary chat_options 전달 semantics가 다르다.

## 7. 소스 맵

| 파일 | 확인한 책임 |
| --- | --- |
| [src/panels/tuningFields.ts](src/panels/tuningFields.ts) | 전용 Server/Speculative/Reasoning/Sampling field, 범위, advanced chat key/default |
| [src/panels/tuningValidation.ts](src/panels/tuningValidation.ts) | spec/mirostat enum, raw server arg parser, blocked app-managed CLI, reserved chat keys |
| [src/panels/useTuningController.ts](src/panels/useTuningController.ts) | draft/commit, preset/reset, restart/rollback, raw args/chat JSON 저장 |
| [src/panels/Tuning.tsx](src/panels/Tuning.tsx) 및 section files | 실제 Tuning UX와 적용 시점 표시 |
| [src/panels/qwenDefaults.ts](src/panels/qwenDefaults.ts) | Qwen3.8 dedicated/raw/request profile 값 |
| [src/api.ts](src/api.ts) | OpenAI chat body merge, /v1/chat/completions, models/embedding/LoRA 호출 |
| [src/chatUtils.ts](src/chatUtils.ts) | request 직전 max_tokens context cap |
| [src/panels/useChatSend.ts](src/panels/useChatSend.ts) | history trim, sampling/options 구성, chat stream 호출 |
| [src/endpointAdapters.ts](src/endpointAdapters.ts) | Native /api/v1/chat, Anthropic gateway 변환 및 subset forwarding |
| [src/modelProfiles.ts](src/modelProfiles.ts) | server/model profile patch 및 stop strings/chat options 저장 |
| [src/components/ExecutionProfiles.tsx](src/components/ExecutionProfiles.tsx) | profile UI에서 server fields, advanced numeric, raw JSON 편집 |
| [src-tauri/src/config.rs](src-tauri/src/config.rs) | AppConfig, defaults, normalization, serialized size/filename validation, raw block list |
| [src-tauri/src/server.rs](src-tauri/src/server.rs) | canonical argv builder, child spawn, memory estimate, status/idle behavior |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs) | start validation, runtime capability probe, lifecycle/gateway commands |
| [README.md](README.md) | 사용자-facing tuning semantics와 escape-hatch 설명 |

### upstream source of truth

- [llama.cpp tools/server/README.md (자동 생성 CLI help 및 HTTP API 문서)](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.cpp tools/server/server-schema.cpp (현재 completion/chat request field 정의)](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-schema.cpp)
- [llama.cpp tools/server/server.cpp (route 등록 및 server 동작)](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server.cpp)

이 문서는 upstream master 인벤토리를 제품 설계에 사용할 수 있도록 정리한 초안이다. 릴리스 전에는 설치된 runtime마다 llama-server --help, request smoke test, 그리고 reserved-option collision test를 다시 실행해야 한다.

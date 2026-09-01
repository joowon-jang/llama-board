import type { Locale } from "./i18nCatalog";

/**
 * `extra.<key>` namespace data (see `i18nUnified.ts`'s `translate()`) —
 * supplementary strings for Discover, Tuning and Runtimes that were added
 * after `panelI18n.ts` (`panel.`) was already in use for that panel; new
 * entries for those panels should still prefer `panel.` when the string is a
 * common action/empty-state shared with other panels.
 */
export type ExtraTextKey =
  | "discoverTitle" | "discoverDescription" | "searchPlaceholder" | "searching" | "search"
  | "searchResults" | "readingFiles" | "selectRepository" | "noFiles" | "download" | "downloadProjector"
  | "downloading" | "tuningPresets" | "saved" | "restartRequired" | "applying" | "applyFailed"
  | "serverSide" | "perRequest" | "applyRestart" | "serverRunning" | "serverStopped"
  | "loading" | "restartNeeded" | "savedNextMessage" | "moreSampling" | "serverSettingsChanged" | "previousValues" | "restartNow"
  | "reasoningDescription" | "presetLoaded" | "defaultsLoaded" | "savedNextStart" | "advancedSaved" | "advancedSavedDraftPending" | "conversationsRemainSaved" | "saveServerArguments" | "saveChatOptions"
  | "tuningNavigationLabel" | "quickMode" | "advancedMode" | "tuningDetailLevel" | "searchTuningSettingsLabel" | "searchSettingsPlaceholder" | "clearTuningSearch" | "categories" | "tuningCategoriesLabel" | "noMatchingSettings" | "noSettingsMatchQuery" | "tuningSubtitle"
  | "tuningCategoryRuntime" | "tuningCategoryRuntimeDesc" | "tuningCategoryContext" | "tuningCategoryContextDesc" | "tuningCategorySampling" | "tuningCategorySamplingDesc" | "tuningCategoryReasoning" | "tuningCategoryReasoningDesc" | "tuningCategorySpeculative" | "tuningCategorySpeculativeDesc" | "tuningCategoryMultimodal" | "tuningCategoryMultimodalDesc" | "tuningCategoryAdvanced" | "tuningCategoryAdvancedDesc"
  | "samplerChainTitle" | "samplerChainHint" | "samplerChainCount" | "samplerChainEmpty" | "samplerChainAdd" | "samplerChainAddPlaceholder";

type ExtraCatalog = Record<ExtraTextKey, string>;

const en: ExtraCatalog = {
  discoverTitle: "Find GGUF models on Hugging Face",
  discoverDescription: "Search public llama.cpp-compatible repositories, inspect their exact files, and download directly into your configured model library.",
  searchPlaceholder: "Try: Qwen GGUF, Llama 3, Mistral",
  searching: "Searching…", search: "Search", searchResults: "Repositories", readingFiles: "Reading repository files…",
  selectRepository: "Select a repository to inspect its GGUF files and choose a quant.", noFiles: "No GGUF files were found in this repository.",
  download: "Download", downloadProjector: "Download projector", downloading: "Downloading", tuningPresets: "Presets",
  reasoningDescription: "These controls map to llama.cpp reasoning template options. The effort value is also sent per chat request when it is not default.",
  saved: "Saved", restartRequired: "Restart required", applying: "Applying…", applyFailed: "Apply failed", serverSide: "server-side",
  perRequest: "per-request", applyRestart: "Apply & restart server", serverRunning: "server is running", serverStopped: "server is stopped", loading: "Loading…", restartNeeded: "Restart required", savedNextMessage: "Saved to config; used on the next message.", moreSampling: "More llama.cpp sampling controls", serverSettingsChanged: "server settings changed", previousValues: "The running server still uses the previous values.", restartNow: "Apply & restart", presetLoaded: "{name} preset loaded. Apply & restart to use server-side changes.", defaultsLoaded: "Qwen3.8-27B defaults loaded. Apply & restart to use server-side changes.", savedNextStart: "Saved — changes take effect on the next Start.", advancedSaved: "Advanced settings saved. Apply & restart to use them.", advancedSavedDraftPending: "Advanced settings saved; newer draft edits remain unsaved.", conversationsRemainSaved: "conversations remain saved while the server restarts.", saveServerArguments: "Save server arguments", saveChatOptions: "Save chat options",
  tuningNavigationLabel: "Tuning navigation", quickMode: "Quick", advancedMode: "Advanced", tuningDetailLevel: "Tuning detail level", searchTuningSettingsLabel: "Search tuning settings", searchSettingsPlaceholder: "Search settings", clearTuningSearch: "Clear tuning search", categories: "Categories", tuningCategoriesLabel: "Tuning categories", noMatchingSettings: "No matching settings.", noSettingsMatchQuery: "No tuning settings match “{query}”.", tuningSubtitle: "Shape llama.cpp server defaults and per-request sampling from one focused workspace.",
  tuningCategoryRuntime: "Runtime", tuningCategoryRuntimeDesc: "GPU offload, CPU execution, slots, and lifecycle settings.",
  tuningCategoryContext: "Context & memory", tuningCategoryContextDesc: "Context capacity and the values that shape memory use.",
  tuningCategorySampling: "Sampling", tuningCategorySamplingDesc: "Per-request token selection and repetition controls.",
  tuningCategoryReasoning: "Reasoning", tuningCategoryReasoningDesc: "Thinking mode, format, effort, and token budgets.",
  tuningCategorySpeculative: "Speculative", tuningCategorySpeculativeDesc: "Draft-model and speculative decoding controls.",
  tuningCategoryMultimodal: "Multimodal", tuningCategoryMultimodalDesc: "Vision projector and multimodal model sidecars.",
  tuningCategoryAdvanced: "Advanced / raw", tuningCategoryAdvancedDesc: "Future llama.cpp options through the raw escape hatches.",
  samplerChainTitle: "Sampler chain", samplerChainHint: "Drag to reorder the stages used by llama.cpp for each request.",
  samplerChainCount: "{count} stages", samplerChainEmpty: "No sampler override is saved; the runtime default chain is active.",
  samplerChainAdd: "Add", samplerChainAddPlaceholder: "Add sampler…",
 };

const ko: ExtraCatalog = {
  discoverTitle: "Hugging Face에서 GGUF 모델 찾기", discoverDescription: "공개 llama.cpp 호환 저장소를 검색하고 파일을 확인한 뒤 설정한 모델 라이브러리로 직접 다운로드합니다.",
  searchPlaceholder: "예: Qwen GGUF, Llama 3, Mistral", searching: "검색 중…", search: "검색", searchResults: "저장소",
  readingFiles: "저장소 파일을 읽는 중…", selectRepository: "저장소를 선택해 GGUF 파일을 확인하고 양자화를 선택하세요.", noFiles: "이 저장소에 GGUF 파일이 없습니다.",
  reasoningDescription: "llama.cpp의 추론 템플릿 옵션에 대응합니다. effort 값은 기본값이 아닐 때 채팅 요청에도 함께 전송됩니다.",
  download: "다운로드", downloadProjector: "프로젝터 다운로드", downloading: "다운로드 중", tuningPresets: "프리셋", saved: "저장됨",
  restartRequired: "재시작 필요", applying: "적용 중…", applyFailed: "적용 실패", serverSide: "서버 측", perRequest: "요청별", applyRestart: "적용 및 서버 재시작",
  serverRunning: "서버 실행 중", serverStopped: "서버 중지됨", loading: "로딩 중…", restartNeeded: "재시작 필요", savedNextMessage: "설정에 저장되며 다음 메시지부터 사용됩니다.", moreSampling: "추가 llama.cpp 샘플링 제어", serverSettingsChanged: "서버 설정 변경됨", previousValues: "실행 중인 서버는 이전 값을 사용합니다.", restartNow: "적용 및 재시작", presetLoaded: "{name} 프리셋을 불러왔습니다. 서버 측 변경사항을 적용하려면 재시작하세요.", defaultsLoaded: "Qwen3.8-27B 기본값을 불러왔습니다. 서버 측 변경사항을 적용하려면 재시작하세요.", savedNextStart: "저장했습니다. 다음 시작부터 적용됩니다.", advancedSaved: "고급 설정을 저장했습니다. 적용 및 재시작하세요.", advancedSavedDraftPending: "고급 설정을 저장했지만 최신 초안 변경사항은 아직 저장되지 않았습니다.", conversationsRemainSaved: "서버가 재시작되는 동안 대화는 저장된 상태로 유지됩니다.", saveServerArguments: "서버 인자 저장", saveChatOptions: "채팅 옵션 저장",
  tuningNavigationLabel: "튜닝 탐색", quickMode: "간편", advancedMode: "고급", tuningDetailLevel: "튜닝 상세 수준", searchTuningSettingsLabel: "튜닝 설정 검색", searchSettingsPlaceholder: "설정 검색", clearTuningSearch: "튜닝 검색 지우기", categories: "카테고리", tuningCategoriesLabel: "튜닝 카테고리", noMatchingSettings: "일치하는 설정이 없습니다.", noSettingsMatchQuery: "“{query}”에 해당하는 튜닝 설정이 없습니다.", tuningSubtitle: "하나의 작업 공간에서 llama.cpp 서버 기본값과 요청별 샘플링을 조정하세요.",
  tuningCategoryRuntime: "런타임", tuningCategoryRuntimeDesc: "GPU 오프로드, CPU 실행, 슬롯 및 라이프사이클 설정.",
  tuningCategoryContext: "컨텍스트·메모리", tuningCategoryContextDesc: "컨텍스트 용량과 메모리 사용에 영향을 주는 값.",
  tuningCategorySampling: "샘플링", tuningCategorySamplingDesc: "요청별 토큰 선택 및 반복 제어.",
  tuningCategoryReasoning: "추론", tuningCategoryReasoningDesc: "사고 모드, 형식, 노력 및 토큰 예산.",
  tuningCategorySpeculative: "추론 가속", tuningCategorySpeculativeDesc: "드래프트 모델 및 추론 가속 제어.",
  tuningCategoryMultimodal: "멀티모달", tuningCategoryMultimodalDesc: "비전 프로젝터 및 멀티모달 사이드카.",
  tuningCategoryAdvanced: "고급 / 원시", tuningCategoryAdvancedDesc: "원시 탈출구를 통한 향후 llama.cpp 옵션.",
  samplerChainTitle: "샘플러 체인", samplerChainHint: "요청마다 llama.cpp가 사용하는 단계를 드래그로 재배열하세요.",
  samplerChainCount: "{count} 단계", samplerChainEmpty: "저장된 샘플러 재정의가 없어 런타임 기본 체인이 활성입니다.",
  samplerChainAdd: "추가", samplerChainAddPlaceholder: "샘플러 추가…",
 };

const ja: ExtraCatalog = { ...en, discoverTitle: "Hugging FaceでGGUFモデルを探す", discoverDescription: "公開されたllama.cpp互換リポジトリを検索し、ファイルを確認して設定済みのモデルライブラリへ直接ダウンロードします。", searchPlaceholder: "例: Qwen GGUF、Llama 3、Mistral", searching: "検索中…", search: "検索", searchResults: "リポジトリ", readingFiles: "リポジトリファイルを読み込み中…", selectRepository: "リポジトリを選択してGGUFファイルを確認し、量子化を選択してください。", noFiles: "このリポジトリにGGUFファイルはありません。", download: "ダウンロード", downloadProjector: "プロジェクターをダウンロード", tuningPresets: "プリセット", saved: "保存済み", restartRequired: "再起動が必要", applying: "適用中…", applyFailed: "適用に失敗しました", serverSide: "サーバー側", perRequest: "リクエストごと", applyRestart: "適用してサーバーを再起動", serverRunning: "サーバー実行中", serverStopped: "サーバー停止", loading: "読み込み中…", restartNeeded: "再起動が必要", savedNextMessage: "設定に保存され、次のメッセージから使用されます。", moreSampling: "その他のllama.cppサンプリング設定", serverSettingsChanged: "サーバー設定が変更されました", previousValues: "実行中のサーバーは以前の値を使用しています", restartNow: "適用して再起動", downloading: "ダウンロード中" };
const zh: ExtraCatalog = { ...en, discoverTitle: "在 Hugging Face 查找 GGUF 模型", discoverDescription: "搜索公开的 llama.cpp 兼容仓库，检查文件并直接下载到已配置的模型库。", searchPlaceholder: "例如：Qwen GGUF、Llama 3、Mistral", searching: "正在搜索…", search: "搜索", searchResults: "仓库", readingFiles: "正在读取仓库文件…", selectRepository: "选择仓库以查看 GGUF 文件并选择量化版本。", noFiles: "此仓库中没有 GGUF 文件。", download: "下载", downloadProjector: "下载投影器", tuningPresets: "预设", saved: "已保存", restartRequired: "需要重启", applyRestart: "应用并重启服务器", serverRunning: "服务器运行中", serverStopped: "服务器已停止" };

export const extraText: Record<Locale, ExtraCatalog> = { en, ko, ja, zh };

export function assertExtraCatalogComplete(): void {
  for (const locale of ["en", "ko", "ja", "zh"] as const) {
    for (const key of Object.keys(en) as ExtraTextKey[]) {
      if (!extraText[locale][key]?.trim()) throw new Error(`Missing extra translation: ${locale}.${key}`);
    }
  }
}

assertExtraCatalogComplete();

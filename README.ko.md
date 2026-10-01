[English](README.md) | [简体中文](README.zh-CN.md) | **한국어**

<div align="center">
  <a href="https://github.com/amsminn/omp-rig">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="omp-rig 로고" src=".github/images/logo-light.svg" width="50%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>목록 하나로 omp의 모든 모델 역할과 모델 풀을 바꾸세요.</h3>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/v/omp-rig" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT" target="_blank"><img src="https://img.shields.io/npm/l/omp-rig" alt="License"></a>
  <a href="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml" target="_blank"><img src="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/dm/omp-rig" alt="npm downloads"></a>
</div>

<br>

omp-rig는 [omp](https://github.com/can1357/oh-my-pi) 코딩 에이전트용 플러그인입니다. rig는 저장해 둔 모델 설정 묶음이에요. 모든 모델 역할(`default`, `smol`, `slow`, `plan` 등)과 omp가 쓸 수 있는 모델 및 프로바이더가 여기에 담깁니다. 목록에서 rig 하나를 고르면 실행 중인 세션에서 이 설정이 한꺼번에 바뀝니다. 재시작할 필요도, `config.yml`을 고칠 필요도 없습니다. 끄면 원래 쓰던 설정이 그대로 돌아옵니다.

> [!TIP]
> 기억할 명령어는 `/rig` 하나뿐입니다. rig와 omp 프로필 목록을 열어 각 항목의 모델을 같은 줄에 보여 주고, 방향키와 Enter만으로 적용, 편집, 저장을 할 수 있습니다.

## 빠른 시작

```bash
omp plugin install omp-rig
```

GitHub에서 바로 설치할 수도 있습니다.

```bash
omp plugin install github:amsminn/omp-rig
```

새 머신에서는 npx로 설치해도 됩니다. `omp plugin install omp-rig@latest`를 대신 실행해 줍니다.

```bash
npx omp-rig install
```

그다음 omp 안에서 입력하세요.

```text
/rig
```

`+ Save current setup as new rig`를 고르면 지금 쓰는 모델로 첫 rig가 만들어집니다. 나중에 역할을 바꾸고 두 번째 rig를 저장해 두면, 둘 사이를 오가는 건 목록을 열고 Enter 한 번 누르는 일이 됩니다. 처음부터 만들고 싶다면 `+ Build new rig`가 한 단계씩 안내해 줍니다.

## 작동 방식

rig는 세 가지 스코프 중 하나에 적용됩니다. 더 구체적인 쪽이 이깁니다: **session > project > global**.

| 스코프 | 선택이 저장되는 곳 | 유지 범위 |
| --- | --- | --- |
| session (기본값) | 세션 기록에 남는 항목 하나 | 이 세션. `/resume`, 재시작, 브랜치도 포함 |
| project | 프로젝트 디렉터리의 `.omp/rig` | 그 프로젝트에서 시작하는 모든 세션 |
| global | omp 에이전트 디렉터리의 `rig.active` | 현재 omp 프로필의 모든 세션 |

rig 자체는 `config.yml`에 절대 복사되지 않습니다. omp-rig는 rig를 omp의 런타임 설정 레이어에 씁니다. 이 레이어는 전역 설정과 프로젝트 설정 위에 얹혀 있고, `/rig off`를 실행하면 다시 지워집니다. rig는 켜져 있는 동안 설정을 가릴 뿐, 설정 그 자체는 아닙니다. `omp config get modelRoles`는 여전히 저장해 둔 값을 보여 줍니다.

모든 역할이 한 번에 교체됩니다. rig에 적히지 않은 채팅 역할은 rig의 `default` 모델을 쓰기 때문에, 기존 설정이나 직전 rig의 값이 섞여 들어오지 않습니다. 이미지, 음성, 웹 역할은 rig가 직접 지정하지 않는 한 설정된 모델을 그대로 유지합니다.

무언가를 바꾸기 전에 omp-rig는 rig의 모든 모델을 점검합니다. 모델을 찾을 수 있는지, 자격 증명이 유효한지, rig 자신의 모델 풀 안에 있는지 확인하죠. 하나라도 통과하지 못하면 아무것도 적용하지 않고 문제를 전부 알려 줍니다.

모델 풀은 프로바이더 단위로 강제됩니다. 목록(Ctrl+P, `/model`)은 `enabledModels`를 따르고, 서브에이전트는 rig 밖의 프로바이더만 막힙니다. `inferhub/*` 같은 패턴은 빈틈없이 적용됩니다. 반면 `inferhub/glm-5.3-flash`처럼 좁은 패턴은 목록에서 다른 inferhub 모델을 숨기지만, 서브에이전트가 이름을 콕 집어 요청하면 여전히 쓸 수 있습니다. `/rig doctor`가 이 경우를 경고해 줍니다.

명령줄에서 지정한 역할(`--model`, `--smol`, `--slow`, `--plan` 또는 대응하는 환경 변수)은 시작할 때 적용되는 rig보다 우선합니다. 상태 줄에는 활성 rig가 `rig: <name>`(또는 `profile: <name>`)으로 표시됩니다. `/model`로 다른 모델을 고른 뒤처럼 역할이 rig와 달라지면 `*`가 붙습니다.

rig는 `~/.omp/rigs/`에 저장되고 모든 omp 프로필이 함께 씁니다. `--profile`, `OMP_PROFILE`, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`도 모두 그대로 따릅니다.

## Rig 파일

rig는 각각 `~/.omp/rigs/<name>.yml`에 있는 YAML 파일입니다. omp의 설정 이름을 그대로 쓰니까 rig와 `config.yml` 사이에서 스니펫을 어느 쪽으로든 붙여 넣을 수 있습니다.

| 키 | 필수 | 의미 |
| --- | --- | --- |
| `modelRoles` | 예 | 역할별 `provider/model[:level]`. `default`는 반드시 지정 |
| `enabledModels` | 아니요 | omp가 목록에 보여 주고 쓸 수 있는 모델 패턴. 인증된 나머지 프로바이더는 차단 |
| `disabledProviders` | 아니요 | 서브에이전트를 포함한 모든 경로에서 차단할 프로바이더 |
| `description` | 아니요 | 목록에 표시되는 한 줄 설명 |

레벨은 `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` 중 하나입니다. 이름은 `^[a-z0-9][a-z0-9._-]{0,63}$`에 맞아야 하고, `list`나 `off` 같은 명령어 단어는 이름으로 쓸 수 없습니다. 그 밖의 키가 들어 있으면 오류로 처리됩니다.

평소 작업은 Claude, 무거운 작업은 Codex에게 맡기는 rig(`~/.omp/rigs/cc.yml`):

```yaml
description: Claude for everyday work, Codex for hard problems
modelRoles:
  default: anthropic/claude-sonnet-4-5:medium
  smol: anthropic/claude-haiku-4-5:low
  slow: openai/gpt-5.1-codex:xhigh
  plan: openai/gpt-5.1-codex:high
enabledModels: [anthropic/*, openai/*]
```

`inferhub` 프로바이더를 통해 중국 모델만 쓰는 rig(`~/.omp/rigs/cn.yml`):

```yaml
description: Chinese models only (inferhub)
modelRoles:
  default: inferhub/glm-5.3-flash:high
  smol: inferhub/deepseek-v4.1-flash:low
enabledModels: [inferhub/*]
disabledProviders: [anthropic]
```

`cn`이 켜져 있으면 Ctrl+P와 `/model`에는 inferhub 모델만 나옵니다. 메인 세션도, 그 서브에이전트도 Anthropic을 비롯해 풀 밖의 어떤 프로바이더도 호출할 수 없습니다.

## 명령어

| 명령어 | 하는 일 |
| --- | --- |
| `/rig` | rig 목록 열기 |
| `/rig <name> [--scope session\|project\|global]` | rig 적용. 명확히 하고 싶다면 `rig:<name>` 또는 `profile:<name>` 사용 |
| `/rig list` | rig 목록 열기 (UI가 없으면 일반 텍스트로 출력) |
| `/rig show <name>` | rig 또는 프로필 보기 |
| `/rig current` | 활성 rig, 스코프별 선택, 실제로 적용된 역할 보기 |
| `/rig diff` | rig를 적용한 뒤 바뀐 역할 보기 |
| `/rig new [name]` | rig를 단계별로 만들거나, 현재 설정을 `<name>`으로 저장 |
| `/rig edit <name>` | 역할 편집기 또는 YAML로 rig 편집 |
| `/rig update <name>` | rig를 현재 설정으로 교체 |
| `/rig rename <name> <new-name>` | rig 이름 바꾸기 |
| `/rig duplicate <name> <new-name>` | rig 복사 |
| `/rig remove <name>` | rig 삭제 |
| `/rig off [--scope session\|project\|global]` | 해당 스코프에서 내 omp 설정 사용 |
| `/rig clear [--scope session\|project\|global]` | 해당 스코프의 선택을 지워 한 단계 아래 스코프가 적용되게 하기 |
| `/rig next` | 알파벳 순서로 다음 rig 적용 |
| `/rig prev` | 이전 rig 적용 |
| `/rig doctor` | 쓸 수 있는 모델을 기준으로 모든 rig 점검 |
| `/rig import <file> [name]` | rig 파일 가져오기 |
| `/rig export <name> [file]` | rig 파일 내보내기 |
| `/rig help` | 명령어 도움말 보기 |

`/rigs`는 `/rig`의 별칭입니다. 하위 명령, rig 이름, `--scope` 값에는 자동 완성과 인라인 힌트가 붙고, 직접 입력한 명령은 print 모드와 RPC 모드에서도 동작합니다.

세션에 rig를 적용한 채로 omp를 시작하려면:

```bash
omp --rig cn
```

기본으로 묶인 키는 없습니다. 단축키로 rig를 돌려 가며 쓰고 싶다면 직접 지정하세요.

```bash
omp plugin config set omp-rig cycleKey ctrl+alt+r
```

## 왜 omp-rig인가요?

- **모든 역할을 한 번에**: rig에 없는 역할은 rig의 `default` 모델로 돌아가므로, 기존 설정이나 직전 rig의 흔적이 남지 않습니다
- **역할만이 아니라 모델 풀까지**: omp가 믿을 만한 모델만 쓰게 하고, 나머지 프로바이더는 서브에이전트까지 모두 막습니다
- **재시작도, 설정 수정도 없이**: rig는 설정 위의 런타임 레이어에 있고, `/rig off` 한 번이면 원래 설정으로 바로 돌아갑니다
- **반쯤 적용되는 일은 없습니다**: 바꾸기 전에 모든 모델의 매칭, 자격 증명, 풀 적합성을 확인합니다
- **작업 방식에 맞춘 스코프**: 한 세션에서 rig를 시험해 보고, 프로젝트에 고정하거나, 전역 기본값으로 삼을 수 있습니다
- **omp 프로필도 Enter 한 번**: 기존 프로필이 `profile:` 항목으로 나타나서, 세션을 떠나지 않고도 그 모델 설정을 빌려 쓸 수 있습니다
- **목록 하나로 전부 관리**: 파일을 건드리지 않고 rig를 저장, 생성, 편집, 이름 변경, 복제, 가져오기, 내보내기, 삭제할 수 있습니다

---

## 참고 자료

- [omp](https://github.com/can1357/oh-my-pi): omp-rig가 붙는 코딩 에이전트
- [Issues](https://github.com/amsminn/omp-rig/issues): 버그 제보와 기능 요청
- [변경 기록](CHANGELOG.md): 릴리스마다 바뀐 내용
- [라이선스](LICENSE): MIT

---
name: ppt-kit
description: storyboard.json + 版式库模板 → PPTX 全流程工作台。准备(storyboard) → 出片(渲染) → 质检(对照核验) → 交互调版式(viewer 切换) → 可选优化(版式多样性)。双入口：agent 走 CLI 自动路径；用户人工精调由 agent 后台拉起 GUI 向导。用于批量出片、版式治理、图文表图表混排 PPT 生成与核验。
keywords: ["ppt", "pptx", "版式库", "storyboard", "批量出片", "图表ppt", "演示文稿", "汇报", "幻灯片", "版式治理", "图文混排"]
version: 1.0.0
---

# ppt-kit：storyboard → PPTX 全流程工作台

## SmallClaw 适配 · 工作目录约定（重要）
本 skill 的所有 `python scripts/...` 命令**必须在 skill 根目录**（即本 SKILL.md 所在、含 `scripts/` 子目录的目录）下执行。SmallClaw 的 shell 工具默认工作目录是项目根，不会自动切到 skill 目录。执行前请先：
- 定位：用 `find .smallclaw/skills/ppt-kit -name render_pptx.py` 找到脚本，取其父目录即 skill 根；或直接 `cd` 到该目录。
- 产物输出：`-o` 建议指向工作区绝对路径（如 `工作区/<产物名>.pptx`），避免产物落在 skill 目录内被 git 跟踪。
- 资产已内置：`assets/template.pptx`、`assets/patterns.json`、`assets/layout_index.json` 已随本包就位，命令中 `-t/-p/-l` 可省略（脚本自动探测同级 `assets/`）。

## 安装

把本包（zip 或目录）放到任一 skill 根目录（如 `%USERPROFILE%\Doubao\skills\` 或客户端
skills 目录），保持顶层目录名 `ppt-kit/` 不变即可被识别；本机开发时直接把 `E:\ppt-kit`
软链/拷贝到 skill 根目录也能直接加载。依赖：`python-pptx`、`lxml`（缩略图可选 `pywin32`，
走 PowerPoint COM 时需要，无则自动降级）。本机已预装上述依赖，未装时用 pip 安装即可。

## 双入口设计

| 入口 | 适用 | 谁操作 |
| --- | --- | --- |
| **CLI 自动路径** | agent 执行全流程（出片/质检/优化/生成 viewer），无需人工介入 | agent |
| **GUI 向导** | 用户要人工精调（选模板、勾选项、看日志、交互换版式） | 用户，agent 后台拉起 |

**规则**：agent 默认走 CLI 自动路径，不得让用户手工敲命令；用户明确要"人工精调/看一下界面"时，agent 用 `Start-Process python -ArgumentList 'scripts/ppt_kit_gui.py'` 后台拉起 GUI 并告知用户操作，agent 自身看不到窗口、无法代点。

## 13 个文件 = 完整 skill 包

```
ppt-kit/
├── SKILL.md                本文件
├── scripts/
│   ├── render_pptx.py      三合一：渲染 + --optimize 版式优化 + --verify 质检 + --verify-only 只质检
│   ├── viewer_tool.py      二合一：缩略图导出 + viewer.html 生成
│   ├── ppt_kit_gui.py      GUI 图形向导（5 步：项目设置→渲染选项→执行渲染→交互调版式→完成）
│   ├── checks.py           质检规则唯一来源（page_issues / page_compat / check_chart_spec）
│   └── resolve_intents.py  intent → pattern 解析（layout_index.json 驱动）
├── assets/
│   ├── template.pptx       默认版式库模板（49 版式）
│   ├── patterns.json       槽位映射（text_slots/image_slots/chart_slot/table_slot + _roles 结构页声明）
│   ├── layout_index.json   intent 分类表（每类候选版式 + desc）
│   └── storyboard.schema.json  storyboard 数据契约
└── examples/
    ├── storyboard.sample.json  11 页示例（含 chart-line 警告样例）
    └── ai-history/
        ├── storyboard.json     20 页完整示例（含图表/复杂版式，可作 agent 参照）
        └── 论文.md             示例源素材（论文 → storyboard 的起点）
```

其余仓库文件（scan_layouts.py、validate_layout_index.py、rename_shapes.py、quick_start.py、
_register_wenwei.py、_gen_wenwei_doc.py、tests/、docs、文卫模板套件）为开发维护工具，
**不属于 skill 包**。文卫模板（140 版式）为可选扩展：拷入包根并配 `-p patterns.wenwei.json -l layout_index.wenwei.json` 使用。

## 工作流（5 环节 → 合并后 2 条命令，均在包根目录运行）

| 环节 | 命令（agent 自动路径） |
| --- | --- |
| ① 准备 | storyboard.json（人工或 LLM 按 schema 生成） |
| ② 出片 + ③ 质检 + ⑤ 优化 | `python scripts/render_pptx.py sb.json -t assets/template.pptx -p assets/patterns.json -l assets/layout_index.json -o out.pptx --optimize --verify` |
| ④ 交互调版式 | `python scripts/viewer_tool.py sb.json --deck out.pptx --template assets/template.pptx -p assets/patterns.json -l assets/layout_index.json -o viewer.html` |

优化与质检已合入渲染：`--optimize` 渲染前做版式多样性治理（相邻不重复 / 全局频次上限，
`--max-repeat` 默认 3）；`--verify` 渲染后对照质检（页数/zip/占位残留/字段对位/图表/表格/notes），
存在 FAIL 时退出码 1。资产路径可省略：脚本自动探测 `../assets/` 与脚本同级目录
（独立布局也兼容）。

## CLI 细节

```powershell
# 渲染 + 优化 + 质检（一条命令，资产自动探测）
python scripts/render_pptx.py sb.json -o out.pptx --optimize --verify

# 只渲染
python scripts/render_pptx.py sb.json -o out.pptx

# 只质检已有产物（不渲染；-o 指向 pptx）
python scripts/render_pptx.py sb.json -o out.pptx --verify-only

# 查看版式清单
python scripts/render_pptx.py --list-patterns

# 生成 viewer（自动导出 deck/模板缩略图，模板缩略图已有则跳过）
python scripts/viewer_tool.py sb.json --deck out.pptx --template assets/template.pptx -o viewer.html

# 只生成 viewer（用已有缩略图）
python scripts/viewer_tool.py sb.json -o viewer.html
```

- 模板缩略图（tpl_*.png）目录已有内容时自动跳过导出，`--force-tpl` 强制重新生成。
- 缩略图为**运行时生成物**，随产物变化，不打包；viewer 引用的 `deck_thumbs/`、`tpl_thumbs/`
  由 viewer_tool 现场生成。
- 多模板：`-p patterns.wenwei.json -l layout_index.wenwei.json -t 文卫最全版式模板.pptx`。

## GUI 用法

`python scripts/ppt_kit_gui.py`（agent 用 `Start-Process python -ArgumentList 'scripts/ppt_kit_gui.py'`
后台拉起）。5 步向导：① 项目设置（storyboard/输出/模板）② 渲染选项（优化/质检勾选 + 命令实时预览）
③ 执行渲染（后台线程实时日志）④ 交互调版式（自动调 viewer_tool 生成 viewer.html 并打开）
⑤ 完成（打开 viewer / 输出目录）。「自定义模板…」独立按钮可手工指定任意 .pptx，patterns/layout 保持当前值。

## 兼容性规则（质检/调版式共用，唯一来源 checks.py）

- **字段兼容**：候选版式 text_slots ⊇ 页面 fields 全部 key。
- **图片**：版式有 image_slots ⇔ 页面有 images（双向约束，防丢图/空图）。
- **图表**：版式 chart_slot/chart_slots ⇔ 页面 chart/charts 必须同侧。
- **表格**：版式 table_slot ⇔ 页面 table 必须同侧。
- **结构页**：cover/toc/section/thanks/qa/refs 不参与多样性优化与重复统计
  （由 patterns 顶层 `_roles` 声明，缺省回退硬编码清单）。
- 版式等价族由 patterns.json text_slots 自动推导（超集 ≤1 槽内视为等价候选）。
- **模板无关性**：换模板只需按 patterns.json 格式登记版式，可选声明
  `_roles`（结构页）/ `_limits`（槽位字数上限，顶层全局 + 版式级覆盖）/
  `_leak_words`（本模板占位词，质检残留检测用，缺省回退内置默认词表）。

## 注意

- 质检允许 WARN（如无 notes、字段不在 text_slots），仅 FAIL 置退出码 1。
- 图表/表格在渲染时深拷贝，多页复用同一版式数据互不干扰（见 tests T8）。
- 本 skill 由 agent 调用时遵循"按需确认"模式：渲染/生成 viewer 属常规操作直接执行。

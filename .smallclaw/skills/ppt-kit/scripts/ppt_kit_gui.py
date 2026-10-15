#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ppt_kit_gui.py — PPT 套件图形向导（下一步式）

把完整工作流封装成 GUI 向导，代替手敲命令行：

    ① 项目设置    选择 storyboard.json、输出文件名、版式模板
    ② 渲染选项    是否版式优化、是否自动质检（附命令预览）
    ③ 执行渲染    实时日志，渲染 + 质检一条龙
    ④ 交互调版式  导出缩略图 + 生成 viewer.html
    ⑤ 完成        产物清单，一键打开 viewer / 输出目录

用法：
    python ppt_kit_gui.py

依赖：python-pptx、lxml；缩略图建议本机安装 PowerPoint 或 LibreOffice
     （无 Office 时自动降级 Pillow，缩略图为白底占位）。
"""

import os
import sys
import json
import queue
import threading
import subprocess
import webbrowser

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)
PY = sys.executable
ENV = dict(os.environ, PYTHONIOENCODING="utf-8")


def _asset(rel):
    """兼容 skill 布局(../assets/…)与独立布局(./assets/… 或 ./*.json)的资产路径。"""
    base = os.path.basename(rel)
    for cand in (os.path.join(SKILL_ROOT, rel),
                 os.path.join(HERE, rel),
                 os.path.join(HERE, "assets", base),
                 os.path.join(HERE, base)):
        if os.path.exists(cand):
            return cand
    return os.path.join(SKILL_ROOT, rel)


# 模板预设：(显示名, 模板路径, patterns, layout_index)
_ALL_PRESETS = [
    ("默认模板（49 版式）",
     _asset("assets/template.pptx"),
     _asset("assets/patterns.json"),
     _asset("assets/layout_index.json")),
    ("文卫最全版式模板（140 版式）",
     _asset("文卫最全版式模板.pptx"),
     _asset("patterns.wenwei.json"),
     _asset("layout_index.wenwei.json")),
]
# 只保留三件套文件都存在的预设（打包后文卫模板不存在时自动隐藏）；
# 极端情况下全部不存在则保留全部，避免列表为空导致索引越界。
TPL_PRESETS = [p for p in _ALL_PRESETS
               if all(os.path.isfile(x) for x in p[1:])] or _ALL_PRESETS
CUSTOM_TPL = "自定义模板…"


def run_cmd(cmd, log):
    """执行一条命令，stdout/stderr 交给 log 回调。返回 (ok, msg)。"""
    display = " ".join('"%s"' % c if (" " in c or "\\" in c) else c for c in cmd)
    log("$ %s\n" % display)
    try:
        proc = subprocess.run(cmd, cwd=HERE, capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              env=ENV, timeout=3600)
    except Exception as e:
        log("[执行异常] %s\n" % e)
        return False, "[执行异常] %s" % e
    if proc.stdout:
        log(proc.stdout)
    if proc.stderr:
        log(proc.stderr)
    if proc.returncode != 0:
        log("[失败] 退出码 %d\n" % proc.returncode)
        return False, "命令退出码 %d" % proc.returncode
    return True, ""


class Wizard(tk.Tk):
    STEPS = ("① 项目设置", "② 渲染选项", "③ 执行渲染", "④ 交互调版式", "⑤ 完成")

    def __init__(self):
        super().__init__()
        self.title("PPT 套件 · 图形向导")
        self.geometry("920x660")
        self.minsize(840, 580)

        # ---- 配置状态 ----
        self.var_sb = tk.StringVar()
        self.var_out = tk.StringVar(value="out.pptx")
        self.var_tpl = tk.StringVar(value=TPL_PRESETS[0][1])
        self.var_tpl_name = tk.StringVar(value=TPL_PRESETS[0][0])
        self.var_opt = tk.BooleanVar(value=True)
        self.var_ver = tk.BooleanVar(value=True)
        self.var_vw = tk.BooleanVar(value=True)
        self.var_force = tk.BooleanVar(value=False)
        self.var_link = tk.StringVar(value="patterns.json · layout_index.json")
        self.var_cmd_preview = tk.StringVar()

        self.step = 0
        self.q = queue.Queue()
        self.busy = False
        self.rendered_sb = ""   # 实际用于渲染的 storyboard（optimize 后为 opt.json）
        self.out_pptx = ""      # 渲染产物绝对路径
        self.last_ok = False

        self._build_layout()
        self._build_step0()
        self._build_step1()
        self._build_step2()
        self._build_step3()
        self._build_step4()
        self._show_step(0)
        self.after(100, self._poll_queue)

    # ------------------------------------------------------------------ UI 骨架
    def _build_layout(self):
        style = ttk.Style(self)
        style.theme_use("vista" if "vista" in style.theme_names() else "clam")
        font = ("Microsoft YaHei UI", 10)

        # 顶栏
        head = tk.Frame(self, bg="#1f6feb", height=52)
        head.pack(side="top", fill="x")
        tk.Label(head, text="PPT 套件 · 图形向导", bg="#1f6feb", fg="white",
                 font=("Microsoft YaHei UI", 14, "bold")).pack(side="left", padx=18, pady=10)
        self.head_hint = tk.Label(head, text="", bg="#1f6feb", fg="#d7e6ff",
                                  font=("Microsoft YaHei UI", 9))
        self.head_hint.pack(side="right", padx=18)

        # 主体：左侧导航 + 右侧内容
        main = tk.Frame(self)
        main.pack(side="top", fill="both", expand=True)
        self.nav = tk.Frame(main, width=170, bg="#f2f3f5")
        self.nav.pack(side="left", fill="y")
        self.nav.pack_propagate(False)
        self.nav_labels = []
        for i, s in enumerate(self.STEPS):
            lb = tk.Label(self.nav, text=s, anchor="w", padx=16, pady=10,
                          bg="#f2f3f5", fg="#4a4f57", font=("Microsoft YaHei UI", 10))
            lb.pack(fill="x")
            self.nav_labels.append(lb)

        self.content = tk.Frame(main, bg="white")
        self.content.pack(side="left", fill="both", expand=True)
        self.frames = {}

        # 底部按钮条
        foot = tk.Frame(self, bg="#f7f8fa")
        foot.pack(side="bottom", fill="x")
        self.btn_prev = ttk.Button(foot, text="← 上一步", command=self._go_prev)
        self.btn_prev.pack(side="left", padx=(14, 4), pady=10)
        self.btn_next = ttk.Button(foot, text="下一步 →", command=self._go_next)
        self.btn_next.pack(side="right", padx=(4, 14), pady=10)
        self.btn_run = ttk.Button(foot, text="开始执行 ▶", command=self._run_current)
        self.btn_run.pack(side="right", padx=4, pady=10)

    def _frame(self, key):
        if key not in self.frames:
            f = tk.Frame(self.content, bg="white")
            self.frames[key] = f
        return self.frames[key]

    def _show_step(self, i):
        self.step = i
        for j, lb in enumerate(self.nav_labels):
            lb.config(bg="#1f6feb" if j == i else "#f2f3f5",
                      fg="white" if j == i else "#4a4f57")
        for k, f in self.frames.items():
            f.pack_forget()
        self.frames[i].pack(fill="both", expand=True)
        if i == 4:
            self._refresh_result()
        # 按钮状态
        self.btn_prev.config(state="disabled" if i == 0 else "normal")
        if i == 4:
            self.btn_next.config(text="重新开始 ↻", command=self._restart)
            self.btn_run.pack_forget()
        else:
            self.btn_next.config(text="下一步 →", command=self._go_next)
            if i in (2, 3):
                self.btn_run.pack(side="right", padx=4, pady=10)
                self.btn_run.config(text="开始执行 ▶", state="normal")
            else:
                self.btn_run.pack_forget()
        self.head_hint.config(text=self.STEPS[i])

    # ------------------------------------------------------------ 步骤 0：项目设置
    def _build_step0(self):
        f = self._frame(0)
        tk.Label(f, text="① 项目设置", bg="white", font=("Microsoft YaHei UI", 13, "bold"),
                 fg="#1f2329").pack(anchor="w", padx=24, pady=(22, 6))
        tk.Label(f, text="选择分页脚本与输出位置，开始一条完整出片流程。", bg="white",
                 fg="#5a606a").pack(anchor="w", padx=24)

        box = tk.LabelFrame(f, text="分页脚本（storyboard.json）", padx=12, pady=10, bg="white",
                            font=("Microsoft YaHei UI", 10))
        box.pack(fill="x", padx=24, pady=12)
        row = tk.Frame(box, bg="white")
        row.pack(fill="x")
        tk.Entry(row, textvariable=self.var_sb, width=60, font=("Microsoft YaHei UI", 10)).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="浏览…", command=self._pick_storyboard).pack(side="left", padx=6)

        box2 = tk.LabelFrame(f, text="输出", padx=12, pady=10, bg="white",
                             font=("Microsoft YaHei UI", 10))
        box2.pack(fill="x", padx=24, pady=6)
        row2 = tk.Frame(box2, bg="white")
        row2.pack(fill="x")
        tk.Label(row2, text="成品文件名：", bg="white").pack(side="left")
        tk.Entry(row2, textvariable=self.var_out, width=30, font=("Microsoft YaHei UI", 10)).pack(side="left", padx=6)

        box3 = tk.LabelFrame(f, text="版式模板", padx=12, pady=10, bg="white",
                             font=("Microsoft YaHei UI", 10))
        box3.pack(fill="x", padx=24, pady=6)
        row3 = tk.Frame(box3, bg="white")
        row3.pack(fill="x")
        self.cmb_tpl = ttk.Combobox(row3, textvariable=self.var_tpl_name, state="readonly",
                                    values=[p[0] for p in TPL_PRESETS],
                                    width=32, font=("Microsoft YaHei UI", 10))
        self.cmb_tpl.pack(side="left")
        self.cmb_tpl.bind("<<ComboboxSelected>>", self._on_tpl_selected)
        ttk.Button(row3, text="自定义模板…", command=self._pick_custom_tpl).pack(side="left", padx=6)
        tk.Label(box3, textvariable=self.var_link, bg="white", fg="#5a606a").pack(anchor="w", pady=(6, 0))

    def _pick_storyboard(self):
        p = filedialog.askopenfilename(
            title="选择 storyboard.json", parent=self,
            filetypes=[("JSON 分页脚本", "*.json"), ("所有文件", "*.*")],
            initialdir=HERE)
        if p:
            self.var_sb.set(p)

    def _on_tpl_selected(self, _=None):
        name = self.var_tpl_name.get()
        for i, (n, t, pat, lay) in enumerate(TPL_PRESETS):
            if n == name:
                self._apply_preset(i)
                break

    def _pick_custom_tpl(self):
        """选择预设之外的 .pptx 模板；patterns/layout_index 保持当前值。"""
        p = filedialog.askopenfilename(title="选择自定义模板 PPTX", parent=self,
                                       filetypes=[("PPTX 模板", "*.pptx"), ("所有文件", "*.*")],
                                       initialdir=HERE)
        if p:
            self.var_tpl.set(p)
            self.var_tpl_name.set(CUSTOM_TPL)
            pat, lay = self._preset_files()
            self.var_link.set("自定义模板：%s\npatterns/layout_index 保持当前值（%s · %s）"
                              % (os.path.basename(p), pat, lay))

    def _apply_preset(self, i):
        n, t, pat, lay = TPL_PRESETS[i]
        self.var_tpl.set(t)
        self.var_tpl_name.set(n)
        self.var_link.set("%s · %s" % (pat, lay))

    # ------------------------------------------------------------ 步骤 1：渲染选项
    def _build_step1(self):
        f = self._frame(1)
        tk.Label(f, text="② 渲染选项", bg="white", font=("Microsoft YaHei UI", 13, "bold"),
                 fg="#1f2329").pack(anchor="w", padx=24, pady=(22, 6))
        tk.Label(f, text="按需勾选后处理，右侧会实时预览将要执行的命令。", bg="white",
                 fg="#5a606a").pack(anchor="w", padx=24)

        box = tk.LabelFrame(f, text="后处理", padx=12, pady=10, bg="white",
                            font=("Microsoft YaHei UI", 10))
        box.pack(fill="x", padx=24, pady=12)
        ttk.Checkbutton(box, text="版式多样性优化（相邻不重复 / 频次上限，渲染前自动执行）",
                        variable=self.var_opt).pack(anchor="w", pady=2)
        ttk.Checkbutton(box, text="渲染后自动质检（占位残留 / 溢出 / 字段对位 / 图表数据）",
                        variable=self.var_ver).pack(anchor="w", pady=2)
        ttk.Checkbutton(box, text="生成交互式版式切换器 viewer.html（在④执行）",
                        variable=self.var_vw).pack(anchor="w", pady=2)

        box2 = tk.LabelFrame(f, text="命令预览", padx=12, pady=10, bg="white",
                             font=("Microsoft YaHei UI", 10))
        box2.pack(fill="x", padx=24, pady=6)
        self.lbl_preview = tk.Label(box2, text="", bg="white", fg="#4a4f57", justify="left",
                                    anchor="w", font=("Consolas", 9), wraplength=760)
        self.lbl_preview.pack(fill="x")
        for var in (self.var_opt, self.var_ver, self.var_vw, self.var_sb,
                    self.var_out, self.var_tpl, self.var_tpl_name):
            try:
                var.trace_add("write", lambda *_: self._refresh_preview())
            except Exception:
                pass
        self.cmb_tpl.bind("<<ComboboxSelected>>", lambda *_: self._refresh_preview())
        self._refresh_preview()

    def _refresh_preview(self):
        try:
            cmds, _, _ = self._render_commands()
            text = "\n".join(" ".join(c for c in cmd) for cmd in cmds)
        except Exception:
            text = "（填写① 中的分页脚本后显示完整命令）"
        self.lbl_preview.config(text=text or "（配置完整后显示命令）")

    # ------------------------------------------------------------ 步骤 2：执行渲染
    def _build_step2(self):
        f = self._frame(2)
        tk.Label(f, text="③ 执行渲染", bg="white", font=("Microsoft YaHei UI", 13, "bold"),
                 fg="#1f2329").pack(anchor="w", padx=24, pady=(22, 6))
        tk.Label(f, text="点击「开始执行 ▶」渲染成品；勾选质检时自动附带质检报告。",
                 bg="white", fg="#5a606a").pack(anchor="w", padx=24)
        self.log2 = scrolledtext.ScrolledText(f, height=20, font=("Consolas", 9),
                                              state="disabled", bg="#1e1e1e", fg="#d4d4d4")
        self.log2.pack(fill="both", expand=True, padx=24, pady=10)

    # ------------------------------------------------------------ 步骤 3：交互调版式
    def _build_step3(self):
        f = self._frame(3)
        tk.Label(f, text="④ 交互调版式", bg="white", font=("Microsoft YaHei UI", 13, "bold"),
                 fg="#1f2329").pack(anchor="w", padx=24, pady=(22, 6))
        tk.Label(f, text="导出缩略图并生成 viewer.html —— 在浏览器里逐页换版式、查兼容性。",
                 bg="white", fg="#5a606a").pack(anchor="w", padx=24)
        box = tk.LabelFrame(f, text="viewer 设置", padx=12, pady=10, bg="white",
                            font=("Microsoft YaHei UI", 10))
        box.pack(fill="x", padx=24, pady=10)
        ttk.Checkbutton(box, text="生成 viewer.html（需先完成③ 渲染）",
                        variable=self.var_vw).pack(anchor="w", pady=2)
        ttk.Checkbutton(box, text="强制重新生成模板缩略图 tpl_thumbs（首次生成一次即可）",
                        variable=self.var_force).pack(anchor="w", pady=2)
        self.log3 = scrolledtext.ScrolledText(f, height=18, font=("Consolas", 9),
                                              state="disabled", bg="#1e1e1e", fg="#d4d4d4")
        self.log3.pack(fill="both", expand=True, padx=24, pady=6)

    # ------------------------------------------------------------ 步骤 4：完成
    def _build_step4(self):
        f = self._frame(4)
        tk.Label(f, text="⑤ 完成", bg="white", font=("Microsoft YaHei UI", 13, "bold"),
                 fg="#1f2329").pack(anchor="w", padx=24, pady=(22, 6))
        tk.Label(f, text="本份成品的全部产物如下：", bg="white", fg="#5a606a").pack(anchor="w", padx=24)
        self.lbl_result = tk.Label(f, text="（尚未生成任何产物）", bg="white", fg="#1f2329",
                                   justify="left", anchor="nw", font=("Consolas", 10),
                                   wraplength=780)
        self.lbl_result.pack(fill="x", padx=24, pady=12)
        row = tk.Frame(f, bg="white")
        row.pack(anchor="w", padx=24)
        ttk.Button(row, text="打开 viewer.html", command=self._open_viewer).pack(side="left", padx=(0, 8))
        ttk.Button(row, text="打开输出目录", command=self._open_outdir).pack(side="left", padx=(0, 8))
        ttk.Button(row, text="重新开始", command=self._restart).pack(side="left")

    # ------------------------------------------------------------ 命令编排
    def _render_commands(self):
        """返回 (cmds, use_sb, out)。合并后：一条 render 命令带 --optimize/--verify。"""
        sb = self.var_sb.get().strip()
        out = self.var_out.get().strip() or "out.pptx"
        tpl = self.var_tpl.get().strip()
        pat, lay = self._preset_files()
        cmds = []
        if sb:
            cmd = [PY, "render_pptx.py", sb, "-t", tpl, "-p", pat, "-l", lay, "-o", out]
            if self.var_opt.get():
                cmd.append("--optimize")
            if self.var_ver.get():
                cmd.append("--verify")
            cmds.append(cmd)
        return cmds, sb, out

    def _preset_files(self):
        for n, t, pat, lay in TPL_PRESETS:
            if self.var_tpl.get().strip() == t:
                return pat, lay
        return (_asset("assets/patterns.json"), _asset("assets/layout_index.json"))

    def _viewer_commands(self, use_sb, out):
        tpl = self.var_tpl.get().strip()
        pat, lay = self._preset_files()
        cmd = [PY, "viewer_tool.py", use_sb, "--deck", out, "--template", tpl,
               "-p", pat, "-l", lay, "-o", "viewer.html"]
        if self.var_force.get():
            cmd.append("--force-tpl")
        return [cmd]

    # ------------------------------------------------------------ 执行
    def _run_current(self):
        if self.busy:
            return
        if self.step == 2:
            self._run_render()
        elif self.step == 3:
            self._run_viewer()

    def _run_render(self):
        sb = self.var_sb.get().strip()
        if not sb or not os.path.isfile(sb):
            messagebox.showerror("缺少分页脚本", "请先在① 项目设置中选择 storyboard.json。", parent=self)
            return
        cmds, use_sb, out = self._render_commands()
        self.rendered_sb = use_sb
        self.out_pptx = os.path.abspath(os.path.join(HERE, out))
        self.busy = True
        self.btn_run.config(state="disabled")
        self._log(self.log2, "\n===== 开始执行 =====\n")
        self._run_async(cmds, "log2", self._render_done)

    def _run_viewer(self):
        if not self.out_pptx or not os.path.isfile(self.out_pptx):
            messagebox.showerror("缺少渲染产物", "请先完成③ 执行渲染。", parent=self)
            return
        if not self.var_vw.get():
            messagebox.showinfo("未勾选", "已取消生成 viewer.html（可在② 中重新勾选）。", parent=self)
            return
        cmds = self._viewer_commands(self.rendered_sb, self.out_pptx)
        self.busy = True
        self.btn_run.config(state="disabled")
        self._log(self.log3, "\n===== 生成 viewer =====\n")
        self._run_async(cmds, "log3", self._viewer_done)

    def _run_async(self, cmds, logkey, done_cb):
        """后台线程执行命令；日志通过队列回主线程，避免跨线程操作 tkinter。"""
        def worker():
            ok = True
            msg = ""
            for cmd in cmds:
                ok, msg = run_cmd(cmd, lambda s: self.q.put(("log", (logkey, s))))
                if not ok:
                    break
            self.q.put(("done", (ok, msg, done_cb)))
        threading.Thread(target=worker, daemon=True).start()

    def _log(self, logbox, text):
        logbox.config(state="normal")
        logbox.insert("end", text)
        logbox.see("end")
        logbox.config(state="disabled")

    def _poll_queue(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    logkey, text = payload
                    logbox = self.log2 if logkey == "log2" else self.log3
                    self._log(logbox, text)
                elif kind == "done":
                    ok, msg, cb = payload
                    self.busy = False
                    self.btn_run.config(state="normal")
                    cb(ok, msg)
        except queue.Empty:
            pass
        self.after(100, self._poll_queue)

    def _render_done(self, ok, msg):
        if ok:
            self.last_ok = True
            self._refresh_result()
            messagebox.showinfo("渲染完成",
                                "出片完成%s\n产物：%s" % ("（含质检）" if self.var_ver.get() else "", self.out_pptx),
                                parent=self)
        else:
            self.last_ok = False
            messagebox.showerror("渲染失败", "详见日志。\n%s" % msg, parent=self)

    def _viewer_done(self, ok, msg):
        if ok:
            self.last_ok = True
            self._refresh_result()
            messagebox.showinfo("viewer 已生成",
                                "viewer.html 已生成，可在⑤ 完成中直接打开。",
                                parent=self)
        else:
            self.last_ok = False
            messagebox.showerror("viewer 生成失败", "详见日志。\n%s" % msg, parent=self)

    def _refresh_result(self):
        lines = []
        if self.out_pptx and os.path.isfile(self.out_pptx):
            lines.append("✅ 成品 PPTX：%s" % self.out_pptx)
            lines.append("   质检报告见③ 日志（render --verify 输出）")
        vp = os.path.join(HERE, "viewer.html")
        if os.path.isfile(vp):
            lines.append("✅ 交互切换器：%s" % vp)
        self.lbl_result.config(text="\n".join(lines) if lines else "（尚未生成任何产物）")

    # ------------------------------------------------------------ 导航
    def _go_prev(self):
        if self.busy:
            return
        self._show_step(max(0, self.step - 1))

    def _go_next(self):
        if self.busy:
            return
        if self.step == 0:
            sb = self.var_sb.get().strip()
            if not sb or not os.path.isfile(sb):
                messagebox.showerror("缺少分页脚本", "请选择存在的 storyboard.json。", parent=self)
                return
        self._show_step(min(4, self.step + 1))

    def _restart(self):
        if self.busy:
            return
        self.out_pptx = ""
        self.rendered_sb = ""
        self.last_ok = False
        for lb in (self.log2, self.log3):
            lb.config(state="normal")
            lb.delete("1.0", "end")
            lb.config(state="disabled")
        self.lbl_result.config(text="（尚未生成任何产物）")
        self._show_step(0)

    def _open_viewer(self):
        vp = os.path.join(HERE, "viewer.html")
        if os.path.isfile(vp):
            webbrowser.open("file:///" + vp.replace("\\", "/"))
        else:
            messagebox.showerror("未找到", "viewer.html 尚未生成。", parent=self)

    def _open_outdir(self):
        if self.out_pptx and os.path.isfile(self.out_pptx):
            os.startfile(os.path.dirname(self.out_pptx))  # noqa
        else:
            os.startfile(HERE)  # noqa


def main():
    app = Wizard()
    app.mainloop()


if __name__ == "__main__":
    main()

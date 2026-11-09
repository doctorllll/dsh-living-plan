window.__ModuleLoader__.load({
  id: "dsh-living-plan",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const React = require("react")

    // Colours come from the client's design tokens (--dsw-alias-*), which the
    // app redefines under body[data-ds-dark-theme]; fallbacks are mid-tones
    // that stay legible on either background.
    const CSS = `
.lp-root { --lp-fg: var(--dsw-alias-label-primary); --lp-mute: var(--dsw-alias-label-secondary, rgba(127, 127, 127, .95)); --lp-line: var(--dsw-alias-border-l2, rgba(127, 127, 127, .28)); --lp-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1)); --lp-fill: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .1)); --lp-brand: var(--dsw-alias-brand-primary, #4d7ef0); --lp-warn: var(--dsw-alias-state-warn-primary, #d08a1e); --lp-error: var(--dsw-alias-state-error-primary, #e0503c); height: 100%; overflow: auto; padding: 14px 16px 24px; box-sizing: border-box; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--lp-fg); }
.lp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.lp-title { font-size: 14px; font-weight: 600; }
.lp-ver { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 500; background: color-mix(in srgb, var(--lp-brand) 14%, transparent); color: var(--lp-brand); vertical-align: 1px; }
.lp-btn { border: 1px solid var(--lp-line); background: transparent; color: inherit; border-radius: 6px; font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; }
.lp-btn:hover { background: var(--lp-hover); }
.lp-meta { font-size: 11px; color: var(--lp-mute); margin: 2px 0 12px; word-break: break-all; }
.lp-meta code { font-size: 10.5px; }
.lp-empty { color: var(--lp-mute); padding: 18px 0; }
.lp-banner { margin: 0 0 10px; padding: 6px 9px; border-radius: 6px; background: color-mix(in srgb, var(--lp-warn) 14%, transparent); color: var(--lp-warn); font-size: 12px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.lp-doc h1, .lp-doc h2, .lp-doc h3, .lp-doc h4 { margin: 16px 0 8px; line-height: 1.3; color: var(--lp-fg); }
.lp-doc h1 { font-size: 18px; } .lp-doc h2 { font-size: 15px; } .lp-doc h3 { font-size: 13.5px; } .lp-doc h4 { font-size: 12.5px; }
.lp-doc p { margin: 5px 0; }
.lp-doc ul { margin: 5px 0; padding-left: 20px; }
.lp-doc li { margin: 2px 0; }
.lp-doc strong { color: var(--lp-fg); }
.lp-doc blockquote { margin: 8px 0; padding: 2px 10px; border-left: 3px solid var(--lp-line); color: var(--lp-mute); }
.lp-doc pre { margin: 8px 0; padding: 8px 10px; border-radius: 6px; background: var(--lp-fill); color: var(--lp-fg); overflow: auto; font-size: 12px; }
.lp-doc code { font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; background: var(--lp-fill); color: var(--lp-fg); padding: 0 3px; border-radius: 3px; }
.lp-doc pre code { background: transparent; padding: 0; }
.lp-check { margin: 3px 0; }
.lp-check input { margin-right: 7px; vertical-align: -1px; accent-color: var(--lp-brand); }
.lp-table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.lp-table th, .lp-table td { border: 1px solid var(--lp-line); padding: 4px 8px; text-align: left; vertical-align: top; }
.lp-table th { background: var(--lp-fill); }
.lp-history { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--lp-line); }
.lp-history-label { font-size: 11px; color: var(--lp-mute); margin-bottom: 6px; }
.lp-chip { display: inline-block; margin: 0 5px 5px 0; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--lp-line); font-size: 11px; cursor: pointer; background: transparent; color: inherit; }
.lp-chip:hover { background: var(--lp-hover); }
.lp-chip.on { background: color-mix(in srgb, var(--lp-brand) 14%, transparent); border-color: color-mix(in srgb, var(--lp-brand) 40%, transparent); }
.lp-error { color: var(--lp-error); font-size: 12px; padding: 8px 0; }
`

    function inline(text) {
      const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
      return parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return React.createElement("strong", { key: index }, part.slice(2, -2))
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return React.createElement("code", { key: index }, part.slice(1, -1))
        }
        return part
      })
    }

    function table(rows, key) {
      const cells = rows.map((row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()))
      const header = cells[0]
      const body = cells.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)))
      return React.createElement(
        "table",
        { className: "lp-table", key },
        React.createElement("thead", null, React.createElement("tr", null, header.map((cell, index) => React.createElement("th", { key: index }, inline(cell))))),
        React.createElement("tbody", null, body.map((row, rowIndex) => React.createElement("tr", { key: rowIndex }, row.map((cell, cellIndex) => React.createElement("td", { key: cellIndex }, inline(cell)))))),
      )
    }

    function markdown(text) {
      const lines = String(text ?? "").split("\n")
      const out = []
      let index = 0
      let key = 0
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*```/.test(line)) {
          const language = line.replace(/^\s*```/, "").trim()
          const code = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          out.push(React.createElement("pre", { key: key++ }, React.createElement("code", { "data-lang": language || undefined }, code.join("\n"))))
          continue
        }
        if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
          const rows = []
          while (index < lines.length && /^\s*\|/.test(lines[index])) {
            rows.push(lines[index])
            index += 1
          }
          out.push(table(rows, key++))
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading) {
          out.push(React.createElement("h" + heading[1].length, { key: key++ }, inline(heading[2])))
          index += 1
          continue
        }
        const check = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line)
        if (check) {
          out.push(React.createElement("div", { className: "lp-check", key: key++ }, React.createElement("input", { type: "checkbox", checked: check[1].toLowerCase() === "x", readOnly: true }), inline(check[2])))
          index += 1
          continue
        }
        if (/^\s*-\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^\s*-\s+/, ""))
            index += 1
          }
          out.push(React.createElement("ul", { key: key++ }, items.map((item, itemIndex) => React.createElement("li", { key: itemIndex }, inline(item)))))
          continue
        }
        if (/^\s*>/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ""))
            index += 1
          }
          out.push(React.createElement("blockquote", { key: key++ }, inline(quote.join(" "))))
          continue
        }
        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }
        out.push(React.createElement("p", { key: key++ }, inline(line)))
        index += 1
      }
      return out
    }

    function PlanPane(props) {
      const sessionId = props.sessionId || (props.session && props.session.sessionId) || (props.tab && props.tab.sessionId) || ""
      const [current, setCurrent] = React.useState(null)
      const [historical, setHistorical] = React.useState(null)
      const [error, setError] = React.useState("")
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      const read = React.useCallback(async (version) => {
        if (!sessionId) return
        try {
          const suffix = version === null || version === undefined ? "" : "&version=" + encodeURIComponent(String(version))
          const response = await fetch("api/living-plan?sessionId=" + encodeURIComponent(sessionId) + suffix, { headers: { accept: "application/json" } })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) throw new Error((body && body.error) || ("HTTP " + response.status))
          return body.value
        } catch (failure) {
          throw new Error(failure && failure.message ? failure.message : String(failure))
        }
      }, [sessionId])

      const refresh = React.useCallback(async () => {
        if (!sessionId) return
        setBusy(true)
        try {
          const value = await read(null)
          setCurrent(value)
          setError("")
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [read, sessionId])

      React.useEffect(() => {
        setCurrent(null)
        setHistorical(null)
        setError("")
        if (!sessionId) return undefined
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh, sessionId])

      const openVersion = React.useCallback(async (version) => {
        if (version === null) {
          setHistorical(null)
          return
        }
        try {
          const value = await read(version)
          setHistorical(value)
          setError("")
        } catch (failure) {
          setError(failure.message)
        }
      }, [read])

      const copyPath = React.useCallback(async () => {
        try {
          await navigator.clipboard.writeText(current ? current.path : "")
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          setCopied(false)
        }
      }, [current])

      const viewing = historical !== null
      const shown = viewing ? historical : current
      const history = current && Array.isArray(current.history) ? current.history : []

      return React.createElement(
        "div",
        { className: "lp-root" },
        React.createElement("style", null, CSS),
        React.createElement(
          "div",
          { className: "lp-head" },
          React.createElement("div", { className: "lp-title" }, "计划", shown && shown.version ? React.createElement("span", { className: "lp-ver" }, "v" + shown.version) : null),
          React.createElement(
            "div",
            null,
            current && current.path ? React.createElement("button", { className: "lp-btn", onClick: copyPath, title: current.path }, copied ? "已复制路径" : "复制路径") : null,
            React.createElement("button", { className: "lp-btn", onClick: refresh, disabled: busy, style: { marginLeft: 6 } }, busy ? "刷新中" : "刷新"),
          ),
        ),
        shown && shown.path ? React.createElement("div", { className: "lp-meta" }, shown.updatedBy === "user" ? "用户修改" : shown.updatedBy === "agent" ? "agent 保存" : shown.updatedBy === "inherited" ? "从原会话带来" : "", shown.updatedAt ? " · " + shown.updatedAt : "", React.createElement("br"), React.createElement("code", null, shown.path)) : null,
        error ? React.createElement("div", { className: "lp-error" }, error) : null,
        viewing ? React.createElement("div", { className: "lp-banner" }, React.createElement("span", null, "正在看历史版本 v" + shown.version), React.createElement("button", { className: "lp-btn", onClick: () => openVersion(null) }, "回到当前")) : null,
        !error && shown && shown.markdown
          ? React.createElement("div", { className: "lp-doc" }, markdown(shown.markdown))
          : !error && current && !current.exists
            ? React.createElement("div", { className: "lp-empty" }, "这个会话还没有计划。让 agent 先写一份（plan_write），它会在动手前写出来。", React.createElement("br"), React.createElement("br"), React.createElement("code", null, current.path))
            : null,
        !viewing && history.length > 1
          ? React.createElement(
              "div",
              { className: "lp-history" },
              React.createElement("div", { className: "lp-history-label" }, "历史版本（" + history.length + "）"),
              history.map((entry) => React.createElement("button", {
                key: "v" + entry.version,
                className: "lp-chip",
                title: (entry.at || "") + " · " + entry.bytes + " bytes",
                onClick: () => openVersion(entry.version),
              }, "v" + entry.version)),
            )
          : null,
      )
    }

    function PlanTitle() {
      return React.createElement("span", null, "计划")
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      ctx.inject(["sidebarRightTabs"], (scope) => {
        const disposers = []
        try {
          disposers.push(scope.sidebarRightTabs.register({
            id: "living-plan",
            kind: "living-plan",
            title: () => "计划",
            guide: [{ order: 25, title: () => "计划", description: () => "当前会话的活计划与历史版本" }],
          }))
          disposers.push(scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: "living-plan" }, PlanPane)))
          disposers.push(scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({ name: "sidebar.right.pane.tab.title", key: "living-plan" }, PlanTitle)))
        } catch (error) {
          if (typeof console !== "undefined") console.warn("dsh-living-plan: panel registration failed", error)
        }
        return () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose() } catch {}
          }
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

import { useEffect, useRef } from "react"

// Hero background: an ASCII field behind the copy of the full-bleed blue hero (default since 27 Oct, Luca).
// ?bg=plain shows the plain blue. One absolutely positioned layer (no layout shift), white at low alpha so the
// white copy keeps its contrast, asleep off-screen and when hidden, and a static frame under reduced motion.
export function heroBgFromUrl(): boolean {
  return new URLSearchParams(location.search).get("bg") !== "plain"
}

export function HeroBg() {
  return (
    <div aria-hidden className="hero-bg pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <Glyphs />
    </div>
  )
}

// The ASCII field: an ASCII field on one canvas. Each cell's intensity = slow ambient noise + a "heat" field that the
// pointer paints (soft radius, eased decay ~800ms); intensity picks a character up the density ramp, hot cells
// scramble into Markdown glyphs. Calmer over the copy block. One rAF loop (60fps while heat is live, 30fps ambient),
// asleep off-screen and when the tab is hidden, DPR capped at 2, glyphs blitted from a pre-rendered atlas.
// Reduced motion: one static frame, no pointer. Touch: ambient plus a light trail while dragging.
const RAMP = " .·:-=+*#%@"
const MD = "#[]->*`_"
function Glyphs() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!, host = cv.parentElement!.parentElement!, ctx = cv.getContext("2d")!
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
    const CHARS = RAMP + MD
    let w = 0, h = 0, dpr = 1, cw = 14, ch = 20, cols = 0, rows = 0
    let heat = new Float32Array(0), scr = new Uint8Array(0), calm = new Float32Array(0), btnm = new Float32Array(0)
    // pointer gain: eases to 0 over interactive elements and the copy (~300ms), back to 1 over open blue
    let gain = 1, gainT = 1
    const atlas = document.createElement("canvas"), actx = atlas.getContext("2d")!
    let raf = 0, last = 0, visible = true, hot = 0
    const t0 = performance.now()
    const ptr = { x: 0, y: 0, has: false }
    const buildAtlas = () => {
      const fs = w < 640 ? 12 : 13
      atlas.width = Math.ceil(cw * dpr) * CHARS.length; atlas.height = Math.ceil(ch * dpr)
      actx.setTransform(dpr, 0, 0, dpr, 0, 0); actx.clearRect(0, 0, atlas.width, atlas.height)
      actx.font = `500 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`; actx.textAlign = "center"; actx.textBaseline = "middle"; actx.fillStyle = "#fff"
      for (let k = 0; k < CHARS.length; k++) actx.fillText(CHARS[k], (Math.ceil(cw * dpr) / dpr) * k + cw / 2, ch / 2)
    }
    const layout = () => {
      const r = host.getBoundingClientRect()
      w = r.width; h = r.height; dpr = Math.min(2, devicePixelRatio || 1)
      cw = w < 640 ? 13 : 14; ch = w < 640 ? 19 : 20
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
      cols = Math.ceil(w / cw); rows = Math.ceil(h / ch)
      heat = new Float32Array(cols * rows); scr = new Uint8Array(cols * rows); calm = new Float32Array(cols * rows); btnm = new Float32Array(cols * rows).fill(1)
      // calm mask: intensity eases down to 35% over the copy block (with a soft 60px edge)
      // tight bounds of the actual copy (pill, headline lines, paragraphs, CTAs), not the full-width column
      const parts = Array.from(host.querySelectorAll<HTMLElement>(":scope > .min-w-0 > a, :scope > .min-w-0 h1 .ml > span, :scope > .min-w-0 > p, :scope > .min-w-0 > div > a"))
      const rs = parts.map((e) => { const q = e.getBoundingClientRect(); const rr = document.createRange(); rr.selectNodeContents(e); const t = rr.getBoundingClientRect(); return t.width ? t : q })
      const copy = rs.length ? { left: Math.min(...rs.map((q) => q.left)), right: Math.max(...rs.map((q) => q.right)), top: Math.min(...rs.map((q) => q.top)), bottom: Math.max(...rs.map((q) => q.bottom)) } : null
      const floor = w < 640 ? 0.42 : 0.3
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        let m = 1
        if (copy) {
          const px = x * cw + cw / 2 + r.left, py = y * ch + ch / 2 + r.top
          const dx = Math.max(copy.left - px, 0, px - copy.right), dy = Math.max(copy.top - py, 0, py - copy.bottom)
          m = floor + (1 - floor) * Math.min(1, Math.hypot(dx, dy) / (w < 640 ? 40 : 80))
        }
        calm[y * cols + x] = m
      }
      // buttons and links in the copy: the field fades to ~0 inside each rect with a 16px feather, so nothing shows
      // sharply through the translucent buttons
      const btns = Array.from(host.querySelectorAll<HTMLElement>(":scope > .min-w-0 a")).map((e) => e.getBoundingClientRect())
      if (btns.length) for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const px = x * cw + cw / 2 + r.left, py = y * ch + ch / 2 + r.top
        let m = 1
        for (const b of btns) {
          const dx = Math.max(b.left - px, 0, px - b.right), dy = Math.max(b.top - py, 0, py - b.bottom)
          m = Math.min(m, 0.04 + 0.96 * Math.min(1, Math.hypot(dx, dy) / 16))
        }
        calm[y * cols + x] *= m; btnm[y * cols + x] = m
      }
      buildAtlas(); draw(performance.now(), 0)
    }
    const splat = (x: number, y: number, amt: number) => {
      const R = w < 640 ? 70 : 96, cx0 = Math.max(0, Math.floor((x - R) / cw)), cx1 = Math.min(cols - 1, Math.ceil((x + R) / cw))
      const cy0 = Math.max(0, Math.floor((y - R) / ch)), cy1 = Math.min(rows - 1, Math.ceil((y + R) / ch))
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const d2 = (cx * cw + cw / 2 - x) ** 2 + (cy * ch + ch / 2 - y) ** 2
        const v = amt * Math.exp(-d2 / (2 * (R * 0.45) ** 2))
        if (v < 0.01) continue
        const i = cy * cols + cx
        heat[i] = Math.min(1, heat[i] + v)
        if (v > 0.25 && Math.random() < 0.35) scr[i] = 1 + Math.floor(Math.random() * MD.length)
      }
      hot = 1
    }
    const draw = (now: number, dt: number) => {
      const t = reduce ? 4 : (now - t0) / 1000
      // eased decay: heat halves every ~220ms, so a stroke fades out over ~800ms
      const k = dt ? Math.pow(0.5, dt / 220) : 1
      gain += (gainT - gain) * (dt ? 1 - Math.exp(-dt / 100) : 0)
      if (Math.abs(gainT - gain) > 0.01) hot = 1
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height)
      const sw = Math.ceil(cw * dpr), sh = Math.ceil(ch * dpr)
      let live = 0
      // phones: the copy fills most of the width, so the field outside it runs a little brighter to stay visible
      const boost = w < 640 ? 3.4 : 1
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x
          let ht = heat[i]
          if (ht > 0) { ht *= k; if (ht < 0.004) { ht = 0; scr[i] = 0 } heat[i] = ht; live++ }
          // ambient: two slow travelling sine fields, sharpened so most of the field stays quiet
          const a = Math.sin(x * 0.11 + t * 0.35) + Math.sin(y * 0.17 - t * 0.27 + x * 0.05) + Math.sin((x + y) * 0.06 + t * 0.18)
          // per-cell jitter breaks the sine bands into an organic, grainy field
          const j = (((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5
          const amb = Math.max(0, (a + 3) / 6 + j * 0.28) ** 3 * 0.6
          // the copy block calms the ambient field strongly and the pointer trail only gently
          const v = Math.min(1, amb * calm[i] * (calm[i] > 0.9 ? boost : 1) + ht * gain * btnm[i] * (0.6 + 0.4 * calm[i]))
          if (v < 0.07) continue
          const ci = scr[i] && ht > 0.18 ? RAMP.length + scr[i] - 1 : Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))
          if (ci === 0) continue
          ctx.globalAlpha = Math.min(0.6, 0.08 + v * 0.52)
          ctx.drawImage(atlas, ci * sw, 0, sw, sh, Math.round(x * cw * dpr), Math.round(y * ch * dpr), sw, sh)
        }
      }
      ctx.globalAlpha = 1
      hot = live || Math.abs(gainT - gain) > 0.01 ? 1 : 0
    }
    const tick = (now: number) => {
      raf = 0
      if (!visible || document.hidden) return
      const dt = now - last
      if (dt > (hot ? 15 : 32)) { draw(now, last ? Math.min(dt, 100) : 0); last = now }
      raf = requestAnimationFrame(tick)
    }
    const start = () => { if (!reduce && !raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(tick) } }
    const stop = () => { cancelAnimationFrame(raf); raf = 0 }
    const ro = new ResizeObserver(layout); ro.observe(host)
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); else stop() }); io.observe(host)
    const onVis = () => (document.hidden ? stop() : start())
    document.addEventListener("visibilitychange", onVis)
    // pointer paints along its path (segment-interpolated so fast moves leave a continuous trail)
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
      const over = (e.target as Element | null)?.closest?.("a, button, h1, p, [role=button]")
      gainT = over ? 0 : 1
      if (over) { ptr.x = x; ptr.y = y; ptr.has = true; return }
      const amt = e.pointerType === "touch" ? 0.25 : 0.5
      if (ptr.has) {
        const d = Math.hypot(x - ptr.x, y - ptr.y), n = Math.min(12, Math.ceil(d / 24))
        for (let s = 1; s <= n; s++) splat(ptr.x + ((x - ptr.x) * s) / n, ptr.y + ((y - ptr.y) * s) / n, amt / Math.max(1, n * 0.6))
      } else splat(x, y, amt)
      ptr.x = x; ptr.y = y; ptr.has = true
    }
    const onLeave = () => { ptr.has = false; gainT = 1 }
    if (!reduce) { host.addEventListener("pointermove", onMove, { passive: true }); host.addEventListener("pointerleave", onLeave) }
    document.fonts?.ready.then(layout)
    document.fonts?.addEventListener?.("loadingdone", layout) // the gated display face can arrive after first paint
    const settle = setTimeout(layout, 1600) // after the copy's rise-in, so button rects are final
    start()
    return () => { clearTimeout(settle); document.fonts?.removeEventListener?.("loadingdone", layout); stop(); ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", onVis); host.removeEventListener("pointermove", onMove); host.removeEventListener("pointerleave", onLeave) }
  }, [])
  return <canvas ref={ref} className="glyph-cv absolute inset-0 size-full" />
}

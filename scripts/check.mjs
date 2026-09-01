#!/usr/bin/env node

/* Renders the pages in pages/ with the extension's css and js applied, at a
 * few widths, and fails if the retrofit regressed. Needs a local Chrome.
 *
 *   npm run check
 *   node scripts/check.mjs --pages home,gallery --widths 400 --headful
 */

import {createServer} from 'node:http'
import {readFile, readdir} from 'node:fs/promises'
import {extname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {launch} from 'chrome-launcher'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGES_DIR = join(ROOT, 'pages')

/* 360 is the floor we support, the common android baseline. narrower than
 * that and the message list cannot fit its date column.
 */
const MOBILE_WIDTHS = [360, 400, 768, 1024]
const DESKTOP_WIDTH = 1200
const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1'

/* deviations we looked at and kept. reported every run, and the allowance
 * still fails if one of them gets worse
 */
const ACCEPTED = [
  {
    page: 'send-message',
    width: 768,
    overflow: 60,
    why: 'the message form keeps its field sizes between the breakpoints, on'
      + ' purpose. cols="90" sets the table min-content width.',
  },
]

/* counts catch the markup changing under a rule */
const SELECTOR_EXPECTATIONS = [
  {
    selector: '.box_details td[width="30"]:has(a img)',
    counts: {'user-photo-album-folder': 3, 'user-photo-album': 0, 'playlist': 0},
  },
  {
    selector: '.box_img table[cellpadding="10"]',
    counts: {
      'galerie-video': 1,
      'galerie-video-folder': 1,
      'galerie-video-individual': 0,
      'gallery-large-preview': 0,
      'gallery': 0,
    },
  },
  {selector: '.box_img_resized table', counts: {'gallery': 1}},
  {selector: '#Layer1 #Layer2', counts: {'gallery-large-preview': 1}},
]

/* ratios catch the rule itself being widened, which counts cannot see */
const LAYOUT_EXPECTATIONS = [
  {
    page: 'user-photo-album-folder',
    selector: '.box_details td[width="30"]',
    ratio: {min: 0.35},
    why: 'the photo thumbnail cell is widened to half the row',
  },
  {
    page: 'user-photo-album',
    selector: '.box_details td[width="30"]',
    ratio: {max: 0.25},
    why: 'a folder icon is not a photo',
  },
  {
    page: 'playlist',
    selector: '.box_details td[width="30"]',
    ratio: {max: 0.25},
    why: 'a checkbox is not a photo',
  },
]

/* text that is meant to be cut off with an ellipsis, not wrapped. the
 * measurements above cannot see the difference, a wrapping nickname takes up
 * no more width than an elided one.
 */
const ELLIPSIS_EXPECTATIONS = [
  {
    page: 'ghid-trasee',
    selector: '.table_no_padding a[href*="/profil/"]',
    width: 360,
    why: 'long nicknames beside a comment are elided at 65px',
  },
]

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
}

/* over http, not file://, so the preview iframe stays same-origin */
async function serveRepo () {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)

    if (!/^\/(pages|extension)\//.test(path) || path.includes('..')) {
      res.writeHead(403).end('forbidden')
      return
    }

    try {
      const body = await readFile(join(ROOT, path))
      res.writeHead(200, {'content-type': CONTENT_TYPES[extname(path)] || 'application/octet-stream'})
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {server, port: server.address().port}
}

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  #listeners = new Map()

  static async attach (port) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
    const target = targets.find((t) => t.type === 'page')
    if (!target) {
      throw new Error('no page target to attach to')
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, {once: true})
      ws.addEventListener('error', () => reject(new Error('cdp socket failed')), {once: true})
    })

    return new Cdp(ws)
  }

  constructor (ws) {
    this.#ws = ws

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)

      if (message.id) {
        const pending = this.#pending.get(message.id)
        if (pending) {
          this.#pending.delete(message.id)
          message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
        }
        return
      }

      for (const listener of this.#listeners.get(message.method) || []) {
        listener(message.params)
      }
    })
  }

  send (method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({id, method, params}))

    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject})
      setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`${method} timed out`))
        }
      }, 60000)
    })
  }

  on (method, listener) {
    this.#listeners.set(method, [...(this.#listeners.get(method) || []), listener])
  }

  once (method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.#listeners.set(method, this.#listeners.get(method).filter((l) => l !== listener))
        resolve(params)
      }
      this.on(method, listener)
    })
  }

  async evaluate (expression) {
    const {result, exceptionDetails} = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })

    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    }

    return result.value
  }

  close () {
    this.#ws.close()
  }
}

/* a hotlink protected photo saves as an empty data: url, which measures as if
 * it were its full markup size. stand one in so the layout is honest.
 */
const REPAIR_IMAGES = `(async () => {
  const repaired = []

  for (const img of document.querySelectorAll('img')) {
    const w = parseInt(img.getAttribute('width'), 10)
    const h = parseInt(img.getAttribute('height'), 10)
    if (img.naturalWidth || !w || !h) {
      continue
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    context.fillStyle = '#888'
    context.fillRect(0, 0, w, h)
    img.src = canvas.toDataURL('image/jpeg', 0.3)
    repaired.push(img)
  }

  await Promise.all(repaired.map((img) => img.decode().catch(() => {})))

  return repaired.length
})()`

const MEASURE = `(() => {
  const describe = (el) => el.tagName
    + (el.id ? '#' + el.id : '')
    + (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/)[0]
      : '')

  const html = document.documentElement
  const toggle = document.querySelector('.retro-menu-toggle')
  const viewport = document.querySelector('meta[name="viewport"]')

  /* the innermost thing sticking out, plus the boxes that made it that wide */
  let widest = null
  if (html.scrollWidth > window.innerWidth + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.right > window.innerWidth + 1 && (!widest || box.right > widest.right)) {
        const chain = []
        for (let node = el; node && node !== document.body && chain.length < 5; node = node.parentElement) {
          const width = Math.round(node.getBoundingClientRect().width)
          chain.push(describe(node) + ' ' + width + 'px'
            + (node.getAttribute('width') ? '[width=' + node.getAttribute('width') + ']' : ''))
        }
        widest = {right: box.right, chain: chain.join(' < ')}
      }
    }
  }

  let preview = null
  const frame = document.querySelector('iframe.iframe_img')
  if (frame) {
    try {
      const inner = frame.contentDocument
      const box = frame.getBoundingClientRect()
      preview = {
        box: Math.round(box.width) + 'x' + Math.round(box.height),
        innerScroll: inner.documentElement.scrollWidth + 'x' + inner.documentElement.scrollHeight,
        imgs: inner.querySelectorAll('img').length,
        scrollsX: inner.documentElement.scrollWidth > frame.contentWindow.innerWidth + 1,
        scrollsY: inner.documentElement.scrollHeight > frame.contentWindow.innerHeight + 1,
      }
    } catch (error) {
      preview = {error: String(error)}
    }
  }

  return {
    overflow: Math.max(0, html.scrollWidth - window.innerWidth),
    widest,
    spilling: [...document.querySelectorAll('td')].filter((td) => td.scrollWidth > td.clientWidth + 1).length,
    brokenImages: [...document.querySelectorAll('img')].filter((img) => !img.naturalWidth && img.src).length,
    preview,
    hasMenu: !!document.getElementById('listMenuRoot'),
    toggleDisplay: toggle ? getComputedStyle(toggle).display : null,
    viewportContent: viewport ? viewport.getAttribute('content') : null,
  }
})()`

const EXERCISE_MENU = `(() => {
  const toggle = document.querySelector('.retro-menu-toggle')
  const menu = document.getElementById('listMenuRoot')
  if (!toggle || !menu) {
    return {skipped: true}
  }

  const before = menu.className
  toggle.click()
  const opened = {
    display: getComputedStyle(menu).display,
    aria: toggle.getAttribute('aria-expanded'),
    classes: before + ' -> ' + menu.className,
  }

  /* the site ships a ">" in every parent link, the retrofit makes it the
   * control that expands the submenu
   */
  let submenu = null
  const subind = menu.querySelector('.subind')
  if (subind) {
    subind.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
    const li = subind.closest('li')
    const list = li && li.querySelector('ul')
    submenu = {
      open: !!(li && li.classList.contains('retro-open')),
      display: list ? getComputedStyle(list).display : null,
      visible: list ? list.getBoundingClientRect().height > 0 : false,
    }
  }

  toggle.click()

  return {
    opened,
    submenu,
    closed: {display: getComputedStyle(menu).display, aria: toggle.getAttribute('aria-expanded')},
  }
})()`

/* how many line boxes the element's text occupies. counted over the text
 * nodes, so an element that also holds an avatar is not mistaken for wrapped.
 */
const MEASURE_LINES = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) {
    return null
  }

  /* distinct vertical positions, not rect count: one line of text can come
   * back as several rects when it is split into separate runs
   */
  const tops = new Set()
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) {
      continue
    }
    /* skip the whitespace around it, which sits on the avatar's line
     */
    const text = node.textContent
    const range = document.createRange()
    range.setStart(node, text.length - text.trimStart().length)
    range.setEnd(node, text.trimEnd().length)
    for (const rect of range.getClientRects()) {
      tops.add(Math.round(rect.top))
    }
  }
  const lines = tops.size

  return {
    lines,
    text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24),
    elided: el.scrollWidth > el.clientWidth,
    width: Math.round(el.getBoundingClientRect().width),
    overflowWrap: getComputedStyle(el).overflowWrap,
  }
})()`

const MEASURE_CELL = (selector) => `(() => {
  const cell = document.querySelector(${JSON.stringify(selector)})
  if (!cell) {
    return null
  }
  const row = cell.closest('tr').getBoundingClientRect().width
  const width = cell.getBoundingClientRect().width

  return {cell: Math.round(width), row: Math.round(row), ratio: row ? width / row : 0}
})()`

function parseArgs (argv) {
  const args = {pages: null, widths: null, headful: false}

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--headful') {
      args.headful = true
    } else if (argv[i] === '--pages') {
      args.pages = argv[++i].split(',').map((p) => p.trim()).filter(Boolean)
    } else if (argv[i] === '--widths') {
      args.widths = argv[++i].split(',').map((w) => parseInt(w, 10)).filter(Boolean)
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }

  return args
}

const failures = []
const notes = []

function check (ok, label, detail) {
  if (!ok) {
    failures.push(detail ? `${label} — ${detail}` : label)
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  const css = await readFile(join(ROOT, 'extension/carpati-mobile.css'), 'utf8')
  const js = await readFile(join(ROOT, 'extension/carpati-mobile.js'), 'utf8')

  const pages = args.pages || (await readdir(PAGES_DIR))
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''))
    .sort()

  if (!pages.length) {
    console.error('no pages found in pages/, nothing to check.')
    process.exit(1)
  }

  const widths = args.widths || MOBILE_WIDTHS

  const {server, port} = await serveRepo()
  const chrome = await launch({
    chromeFlags: [
      ...(args.headful ? [] : ['--headless=new']),
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=user-gesture-required',
    ],
  })

  const cdp = await Cdp.attach(chrome.port)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  /* the saved pages have their own scripts disabled, so their inline handlers
   * throw for missing libraries. those are the fixture's, not ours: our
   * injected script has no source url to blame.
   */
  const ourErrors = []
  const fixtureErrors = new Set()
  cdp.on('Runtime.exceptionThrown', ({exceptionDetails}) => {
    const message = exceptionDetails.exception?.description || exceptionDetails.text
    if (exceptionDetails.url?.includes('/pages/')) {
      fixtureErrors.add(message.split('\n')[0])
    } else {
      ourErrors.push(message)
    }
  })

  /* like the extension: stylesheet ahead of the page's own, script at
   * document_start, so its DOMContentLoaded fallbacks get exercised too
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const insert = () => {
        const parent = document.head || document.documentElement
        if (!parent) {
          return false
        }
        const style = document.createElement('style')
        style.textContent = ${JSON.stringify(css)}
        parent.insertBefore(style, parent.firstChild)
        return true
      }

      if (!insert()) {
        const observer = new MutationObserver(() => insert() && observer.disconnect())
        observer.observe(document, {childList: true, subtree: true})
      }

      ${js}
    })()`,
  })

  const load = async (page, width) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', {url: `http://127.0.0.1:${port}/pages/${page}.html`})
    await loaded
    await cdp.evaluate('new Promise((r) => setTimeout(r, 250))')

    if (await cdp.evaluate(REPAIR_IMAGES)) {
      await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    }
  }

  const missing = (page, what) => notes.push(args.pages
    ? `${page} is outside --pages, skipped ${what}`
    : `no ${page}.html in pages/, skipped ${what}`)

  console.log(`checking ${pages.length} pages at ${widths.join(', ')} and ${DESKTOP_WIDTH}px\n`)

  for (const page of pages) {
    const line = [page.padEnd(30)]

    for (const width of widths) {
      const errorsBefore = ourErrors.length
      await load(page, width)
      const m = await cdp.evaluate(MEASURE)
      const where = `${page}@${width}`
      const accepted = ACCEPTED.find((a) => a.page === page && a.width === width)

      if (accepted) {
        check(m.overflow <= accepted.overflow,
          `${where}: scrolls horizontally by ${m.overflow}px, past the ${accepted.overflow}px we accept`,
          m.widest?.chain)

        if (m.overflow) {
          notes.push(`${where}: scrolls horizontally by ${m.overflow}px, accepted — ${accepted.why}`)
        }
      } else {
        check(m.overflow === 0, `${where}: scrolls horizontally by ${m.overflow}px`, m.widest?.chain)
      }

      check(m.viewportContent === VIEWPORT_CONTENT,
        `${where}: viewport meta is "${m.viewportContent}"`, `expected "${VIEWPORT_CONTENT}"`)

      if (m.hasMenu) {
        check(m.toggleDisplay && m.toggleDisplay !== 'none',
          `${where}: menu toggle is ${m.toggleDisplay || 'missing'}`)
      }

      check(m.spilling === 0, `${where}: ${m.spilling} table cells overflow their box`)

      if (m.preview) {
        const shape = `iframe ${m.preview.box}, inner scroll ${m.preview.innerScroll}, ${m.preview.imgs} image(s)`
        check(!m.preview.error, `${where}: could not read the preview iframe`, m.preview.error)
        check(m.preview.scrollsX, `${where}: preview iframe lost its horizontal scroll`, shape)
        check(!m.preview.scrollsY, `${where}: preview iframe scrolls vertically too`, shape)
      }

      if (m.brokenImages) {
        notes.push(`${page}: ${m.brokenImages} image(s) would not load, the fixture may be incomplete`)
      }

      check(ourErrors.length === errorsBefore, `${where}: the retrofit script threw`,
        ourErrors.slice(errorsBefore).join(' | '))

      if (width === widths[0]) {
        const menu = await cdp.evaluate(EXERCISE_MENU)

        if (!menu.skipped) {
          check(menu.opened.display === 'block', `${page}: menu did not open`,
            `display: ${menu.opened.display}, classes "${menu.opened.classes}"`)
          check(menu.opened.aria === 'true', `${page}: aria-expanded did not become true`)
          check(menu.closed.display === 'none', `${page}: menu did not close again`)
          check(menu.closed.aria === 'false', `${page}: aria-expanded did not go back to false`)

          if (menu.submenu) {
            check(menu.submenu.open, `${page}: submenu did not get the open class`)
            check(menu.submenu.visible, `${page}: submenu stayed hidden`,
              `display: ${menu.submenu.display}`)
          }
        }
      }

      line.push(`${width}:${m.overflow === 0 ? 'ok' : (accepted ? 'ok*' : 'OVER')}`)
    }

    /* above the breakpoint the retrofit stays out of the way */
    await load(page, DESKTOP_WIDTH)
    const desktop = await cdp.evaluate(MEASURE)
    if (desktop.hasMenu) {
      check(desktop.toggleDisplay === 'none',
        `${page}@${DESKTOP_WIDTH}: menu toggle shows above the breakpoint`,
        `display: ${desktop.toggleDisplay}`)
    }
    line.push(`${DESKTOP_WIDTH}:${!desktop.hasMenu || desktop.toggleDisplay === 'none' ? 'off' : 'ON?'}`)

    console.log(line.join('  '))
  }

  for (const {selector, counts} of SELECTOR_EXPECTATIONS) {
    for (const [page, expected] of Object.entries(counts)) {
      if (!pages.includes(page)) {
        missing(page, `"${selector}"`)
        continue
      }

      await load(page, 400)
      const actual = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
      check(actual === expected, `${page}: "${selector}" matched ${actual}, expected ${expected}`)
    }
  }

  for (const {page, selector, ratio, why} of LAYOUT_EXPECTATIONS) {
    if (!pages.includes(page)) {
      missing(page, 'its layout check')
      continue
    }

    await load(page, 400)
    const measured = await cdp.evaluate(MEASURE_CELL(selector))

    if (!measured) {
      notes.push(`${page}: no "${selector}" to measure`)
      continue
    }

    const size = `${Math.round(measured.ratio * 100)}% of the row (${measured.cell}px of ${measured.row}px)`

    if (ratio.min !== undefined) {
      check(measured.ratio >= ratio.min, `${page}: "${selector}" is only ${size}`,
        `${why} — expected at least ${ratio.min * 100}%`)
    }

    if (ratio.max !== undefined) {
      check(measured.ratio <= ratio.max, `${page}: "${selector}" takes up ${size}`,
        `${why} — expected at most ${ratio.max * 100}%`)
    }
  }

  for (const {page, selector, width, why} of ELLIPSIS_EXPECTATIONS) {
    if (!pages.includes(page)) {
      missing(page, 'its one-line check')
      continue
    }

    await load(page, width)
    const m = await cdp.evaluate(MEASURE_LINES(selector))

    if (!m) {
      notes.push(`${page}: no "${selector}" to measure`)
      continue
    }

    const shape = `"${m.text}" in ${m.width}px, overflow-wrap ${m.overflowWrap}`

    check(m.lines === 1, `${page}: "${selector}" wrapped onto ${m.lines} lines`, `${why} — ${shape}`)
    check(m.elided, `${page}: "${selector}" is no longer clipped`,
      `${why}, so it should be too long for its box — ${shape}`)
  }

  cdp.close()
  await chrome.kill()
  await new Promise((resolve) => server.close(resolve))

  for (const error of fixtureErrors) {
    notes.push(`a fixture's own script threw, its libraries are not saved: ${error}`)
  }

  if (notes.length) {
    console.log('\nnotes:')
    for (const note of [...new Set(notes)]) {
      console.log(`  - ${note}`)
    }
  }

  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`)
    for (const failure of failures) {
      console.log(`  ✗ ${failure}`)
    }
    process.exit(1)
  }

  console.log('\nall checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

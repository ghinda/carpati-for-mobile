const smallScreen = window.matchMedia('(max-width: 1024px)')

function stripInlineStyles (menu) {
  const strip = (root) => {
    for (const el of root.querySelectorAll('[style]')) {
      el.removeAttribute('style')
    }
  }

  const observer = new MutationObserver((records) => {
    if (!smallScreen.matches) {
      return
    }

    for (const record of records) {
      record.target.removeAttribute('style')
    }
  })

  observer.observe(menu, {
    attributes: true,
    attributeFilter: ['style'],
    subtree: true,
  })

  if (smallScreen.matches) {
    strip(menu)
  }
}

function setupMenu () {
  const menu = document.getElementById('listMenuRoot')
  if (!menu) {
    return
  }

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'retro-menu-toggle'
  toggle.textContent = 'Meniu'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', menu.id)

  toggle.addEventListener('click', () => {
    const open = menu.classList.toggle('retro-menu-open')
    toggle.setAttribute('aria-expanded', String(open))
  })

  menu.parentNode.insertBefore(toggle, menu)

  stripInlineStyles(menu)

  menu.addEventListener('click', (event) => {
    if (!smallScreen.matches) {
      return
    }

    const subind = event.target.closest('.subind')
    if (!subind) {
      return
    }

    event.preventDefault()
    subind.closest('li').classList.toggle('retro-open')
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupMenu)
} else {
  setupMenu()
}

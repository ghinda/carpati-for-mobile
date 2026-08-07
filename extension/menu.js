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

  /* prevent re-adding the menu if it's already there
   */
  if (menu.parentNode.querySelector('.retro-menu-toggle')) {
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

  /* capture click to fix issues with not being able to press top category link
   * on mobile, because of page script.
   */
  menu.addEventListener('click', (event) => {
    if (!smallScreen.matches) {
      return
    }

    const subind = event.target.closest('.subind')
    if (subind) {
      event.preventDefault()
      event.stopPropagation()
      subind.closest('li').classList.toggle('retro-open')
      return
    }

    /* let the parent link navigate, out of the site script's reach
     */
    const link = event.target.closest('a')
    if (link && link.querySelector('.subind')) {
      event.stopPropagation()
    }
  }, true)
}

/* first call needed for when injecting into already loaded page
 */
setupMenu()
document.addEventListener('DOMContentLoaded', setupMenu, {once: true})

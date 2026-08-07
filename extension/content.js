const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1'

function setViewport () {
  const viewport = document.querySelector('meta[name="viewport"]')
  if (!viewport) {
    return false
  }

  if (viewport.getAttribute('content') !== VIEWPORT_CONTENT) {
    viewport.setAttribute('content', VIEWPORT_CONTENT)
  }

  return true
}

/* use an observer to fix issues with super-zoomed-in on back button
 */
if (!setViewport()) {
  const observer = new MutationObserver(() => {
    if (setViewport()) {
      observer.disconnect()
    }
  })

  observer.observe(document, {childList: true, subtree: true})

  document.addEventListener('DOMContentLoaded', () => {
    observer.disconnect()
    setViewport()
  })
}

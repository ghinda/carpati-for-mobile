const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1'

function setViewport () {
  const viewport = document.querySelector('meta[name="viewport"]')
  if (!viewport) {
    return false
  }

  viewport.setAttribute('content', VIEWPORT_CONTENT)
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setViewport)
} else {
  setViewport()
}

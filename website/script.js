// ==========================================================================
// Operecs Browser Landing Page — Interactive Controller
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // 1. Tab Layout Switcher (Vertical vs Horizontal)
  const mockup = document.getElementById('browserMockup');
  const segVertical = document.getElementById('segVertical');
  const segHorizontal = document.getElementById('segHorizontal');

  if (mockup && segVertical && segHorizontal) {
    segVertical.addEventListener('click', () => {
      mockup.classList.remove('mode-horizontal');
      mockup.classList.add('mode-vertical');
      segVertical.classList.add('active');
      segHorizontal.classList.remove('active');
    });

    segHorizontal.addEventListener('click', () => {
      mockup.classList.remove('mode-vertical');
      mockup.classList.add('mode-horizontal');
      segHorizontal.classList.add('active');
      segVertical.classList.remove('active');
    });
  }

  // 2. Accent Color Theme Switcher
  const accentDots = document.querySelectorAll('.accent-dot');
  accentDots.forEach((dot) => {
    dot.addEventListener('click', () => {
      const color = dot.getAttribute('data-color');
      document.body.setAttribute('data-accent', color);

      accentDots.forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
    });
  });

  // 3. Mockup Split View Toggle
  const splitBtn = document.getElementById('mockupSplitBtn');
  const splitPane = document.getElementById('mockupSplitPane');

  if (splitBtn && splitPane) {
    splitBtn.addEventListener('click', () => {
      const isVisible = splitPane.style.display !== 'none';
      if (isVisible) {
        splitPane.style.display = 'none';
        splitBtn.classList.remove('active');
      } else {
        splitPane.style.display = 'flex';
        splitBtn.classList.add('active');
      }
    });
  }

  // 4. Interactive Keyboard Shortcuts Filter
  const searchInput = document.getElementById('shortcutSearch');
  const rows = document.querySelectorAll('.shortcut-row');
  const countBadge = document.getElementById('shortcutCountBadge');

  if (searchInput && rows.length) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      let matchedCount = 0;

      rows.forEach((row) => {
        const name = (row.getAttribute('data-name') || '').toLowerCase();
        const cat = (row.getAttribute('data-category') || '').toLowerCase();
        const text = row.textContent.toLowerCase();

        if (!query || name.includes(query) || cat.includes(query) || text.includes(query)) {
          row.style.display = 'flex';
          matchedCount++;
        } else {
          row.style.display = 'none';
        }
      });

      if (countBadge) {
        countBadge.textContent = query
          ? `${matchedCount} of ${rows.length} shortcuts`
          : `Showing all ${rows.length} shortcuts`;
      }
    });
  }

  // 5. Terminal Gatekeeper Command Copy
  const copyBtn = document.getElementById('copyCmdBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const cmd = 'xattr -cr /Applications/Operecs.app';
      try {
        await navigator.clipboard.writeText(cmd);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.style.color = 'var(--accent)';
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.style.color = '';
        }, 2000);
      } catch {
        // Fallback
        prompt('Copy command:', cmd);
      }
    });
  }

  // 6. Navigation Smooth Scroll Offset
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        const topOffset = 80; // height of fixed navbar + padding
        const elementPosition = target.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - topOffset;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth',
        });
      }
    });
  });
});

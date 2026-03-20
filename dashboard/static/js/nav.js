document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".pg-nav").forEach((nav) => {
    const toggle = nav.querySelector(".pg-nav__toggle");
    const links = nav.querySelector(".pg-nav__links");
    if (!toggle || !links) return;

    const setOpen = (open) => {
      nav.classList.toggle("pg-nav--open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };

    toggle.addEventListener("click", () => {
      const next = !nav.classList.contains("pg-nav--open");
      setOpen(next);
    });

    links.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        if (window.innerWidth <= 980) {
          setOpen(false);
        }
      });
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 980 && nav.classList.contains("pg-nav--open")) {
        setOpen(false);
      }
    });
  });
});

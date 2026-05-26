(function () {
    const sheet = document.querySelector(".sheet");
    if (!sheet) return;

    const dragZone = sheet.querySelector(".sheet-drag-zone");
    const collapsedClass = "is-collapsed";
    const dragThreshold = 48;
    const tapThreshold = 8;
    const defaultCollapsed = sheet.hasAttribute("data-default-collapsed");
    const expandOnDropOnly = sheet.hasAttribute("data-expand-on-drop");
    const desktopQuery = window.matchMedia("(min-width: 768px)");

    let startY = 0;
    let moved = false;

    function isDesktop() {
        return desktopQuery.matches;
    }

    function consumePointerGesture(event) {
        event.preventDefault();
    }

    function setCollapsed(collapsed) {
        if (isDesktop()) {
            collapsed = false;
        }
        sheet.classList.toggle(collapsedClass, collapsed);
        dragZone?.setAttribute("aria-expanded", String(!collapsed));
    }

    function applyLayoutMode() {
        if (isDesktop()) {
            setCollapsed(false);
        } else if (defaultCollapsed) {
            setCollapsed(true);
        }
    }

    if (defaultCollapsed && !isDesktop()) {
        setCollapsed(true);
    } else if (isDesktop()) {
        setCollapsed(false);
    }

    dragZone?.addEventListener("pointerdown", (event) => {
        if (isDesktop() || event.button !== 0) return;
        startY = event.clientY;
        moved = false;
        dragZone.setPointerCapture(event.pointerId);
    });

    dragZone?.addEventListener("pointermove", (event) => {
        if (isDesktop()) return;
        if (Math.abs(event.clientY - startY) > tapThreshold) {
            moved = true;
        }
    });

    dragZone?.addEventListener("pointerup", (event) => {
        if (isDesktop()) return;
        dragZone.releasePointerCapture(event.pointerId);
        const deltaY = event.clientY - startY;

        if (deltaY > dragThreshold) {
            setCollapsed(true);
            consumePointerGesture(event);
            return;
        }
        if (deltaY < -dragThreshold) {
            setCollapsed(false);
            consumePointerGesture(event);
            return;
        }
        if (!moved) {
            const collapsed = sheet.classList.contains(collapsedClass);
            if (expandOnDropOnly) {
                if (collapsed) {
                    setCollapsed(false);
                    consumePointerGesture(event);
                }
            } else {
                setCollapsed(!collapsed);
                consumePointerGesture(event);
            }
        }
    });

    dragZone?.addEventListener("click", (event) => {
        if (!isDesktop()) {
            event.preventDefault();
            event.stopPropagation();
        }
    });

    dragZone?.addEventListener("pointercancel", () => {
        moved = false;
    });

    desktopQuery.addEventListener("change", applyLayoutMode);

    window.TupTupSheet = {
        collapse: () => setCollapsed(true),
        expand: () => setCollapsed(false),
    };
})();

(function () {
    const sheet = document.querySelector(".sheet");
    if (!sheet) return;

    const dragZone = sheet.querySelector(".sheet-drag-zone");
    const collapsedClass = "is-collapsed";
    const dragThreshold = 48;
    const tapThreshold = 8;
    const defaultCollapsed = sheet.hasAttribute("data-default-collapsed");
    const expandOnDropOnly = sheet.hasAttribute("data-expand-on-drop");

    let startY = 0;
    let moved = false;

    function setCollapsed(collapsed) {
        sheet.classList.toggle(collapsedClass, collapsed);
        dragZone?.setAttribute("aria-expanded", String(!collapsed));
    }

    if (defaultCollapsed) {
        setCollapsed(true);
    }

    dragZone?.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        startY = event.clientY;
        moved = false;
        dragZone.setPointerCapture(event.pointerId);
    });

    dragZone?.addEventListener("pointermove", (event) => {
        if (Math.abs(event.clientY - startY) > tapThreshold) {
            moved = true;
        }
    });

    dragZone?.addEventListener("pointerup", (event) => {
        dragZone.releasePointerCapture(event.pointerId);
        const deltaY = event.clientY - startY;

        if (deltaY > dragThreshold) {
            setCollapsed(true);
            return;
        }
        if (deltaY < -dragThreshold) {
            setCollapsed(false);
            return;
        }
        if (!moved) {
            const collapsed = sheet.classList.contains(collapsedClass);
            if (expandOnDropOnly) {
                if (collapsed) setCollapsed(false);
            } else {
                setCollapsed(!collapsed);
            }
        }
    });

    dragZone?.addEventListener("pointercancel", () => {
        moved = false;
    });

    window.TupTupSheet = {
        collapse: () => setCollapsed(true),
        expand: () => setCollapsed(false),
    };
})();

(function () {
    function initStepperIcons() {
        if (typeof lucide === "undefined" || typeof lucide.createIcons !== "function") return;
        lucide.createIcons({
            attrs: {
                "aria-hidden": "true",
                focusable: "false",
            },
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initStepperIcons, { once: true });
    } else {
        initStepperIcons();
    }

    window.TupTupStepper = { refreshIcons: initStepperIcons };
})();

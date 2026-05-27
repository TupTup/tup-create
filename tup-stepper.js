(function () {
    function initStepperIcons(root) {
        if (typeof lucide === "undefined" || typeof lucide.createIcons !== "function") return;
        const options = {
            attrs: {
                "aria-hidden": "true",
                focusable: "false",
            },
        };
        if (root) options.root = root;
        lucide.createIcons(options);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initStepperIcons, { once: true });
    } else {
        initStepperIcons();
    }

    window.TupTupStepper = { refreshIcons: initStepperIcons };
})();

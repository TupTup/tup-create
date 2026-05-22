(function () {
    const printButton = document.getElementById("print-button");
    const form = document.getElementById("recipient-form");
    if (!printButton || !form) return;

    const printName = document.getElementById("print-building-name");
    const printAddress = document.getElementById("print-building-address");
    const printHeader = document.querySelector(".print-header");

    let savedStepIndex = null;

    function floorLabel(value) {
        if (value === "0") return "parter";
        if (value === "-1") return "piwnica";
        return `${value} piętro`;
    }

    function syncPrintHeader() {
        const name =
            form.querySelector('input[name="building_name"]')?.value?.trim() ||
            document.getElementById("building-place-name")?.textContent?.trim() ||
            "";
        const address =
            form.querySelector('input[name="building_address"]')?.value?.trim() ||
            document.getElementById("building-place-address")?.textContent?.trim() ||
            "";

        if (printName) {
            printName.textContent = name;
            printName.hidden = !name;
        }
        if (printAddress) {
            printAddress.textContent = address;
            printAddress.hidden = !address;
        }
        if (printHeader) {
            printHeader.hidden = !name && !address;
        }
    }

    function syncPrintNotes() {
        form.querySelectorAll(".sheet-step").forEach((step) => {
            const note = step.querySelector(".note");
            const hasNote = Boolean(note?.value.trim());
            step.classList.toggle("print-has-note", hasNote);
        });
    }

    function syncPrintDeliveryFloor() {
        const label = document.getElementById("delivery-floor-label");
        const selected = form.querySelector('input[name="delivery_floor"]:checked');
        if (!label || !selected) return;

        const room = label.textContent.split(",")[0]?.trim() || "Miejsce dostawy";
        label.dataset.printFloor = `${room}, ${floorLabel(selected.value)}`;
    }

    function applyPrintFloorLabels() {
        document.querySelectorAll("[data-print-floor]").forEach((node) => {
            node.textContent = node.dataset.printFloor;
        });
    }

    function restorePrintFloorLabels() {
        document.querySelectorAll("[data-print-floor]").forEach((node) => {
            delete node.dataset.printFloor;
        });
    }

    function restorePrintNotes() {
        form.querySelectorAll(".sheet-step.print-has-note").forEach((step) => {
            step.classList.remove("print-has-note");
        });
    }

    function prepareMapForPrint() {
        window.TupTupMap?.setWizardStep("destination");
        window.TupTupMap?.fitMapView();

        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                window.TupTupMap?.fitMapView();
                setTimeout(resolve, 400);
            });
        });
    }

    async function startPrint() {
        savedStepIndex = window.TupTupFlow?.getStepIndex?.() ?? null;

        syncPrintHeader();
        syncPrintNotes();
        syncPrintDeliveryFloor();
        applyPrintFloorLabels();

        document.body.classList.add("is-printing");
        form.classList.add("is-printing");

        await prepareMapForPrint();
        window.print();
    }

    function finishPrint() {
        document.body.classList.remove("is-printing");
        form.classList.remove("is-printing");
        restorePrintFloorLabels();
        restorePrintNotes();

        if (savedStepIndex != null && window.TupTupFlow?.goToStep) {
            window.TupTupFlow.goToStep(savedStepIndex);
        }
        savedStepIndex = null;
    }

    printButton.addEventListener("click", () => {
        startPrint().catch(() => finishPrint());
    });

    window.addEventListener("beforeprint", () => {
        if (!document.body.classList.contains("is-printing")) {
            syncPrintHeader();
            syncPrintNotes();
            syncPrintDeliveryFloor();
            applyPrintFloorLabels();
            window.TupTupMap?.setWizardStep("destination");
            window.TupTupMap?.fitMapView();
        }
    });

    window.addEventListener("afterprint", finishPrint);
})();

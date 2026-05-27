(function () {
    const form = document.getElementById("recipient-form");
    if (!form) return;

    const STEPS = ["parking", "entrance", "destination"];
    const STEP_ICONS = {
        parking: "circle-parking",
        entrance: "door-closed",
        destination: "map-pin",
    };
    const heroTitle = document.getElementById("hero-title");
    const heroDesc = document.getElementById("hero-desc");
    const floorPicker = document.getElementById("floor-picker");
    const backButton = document.getElementById("back-button");
    const stepAction = document.getElementById("step-action");
    const sheetSteps = [...form.querySelectorAll(".sheet-step")];
    const tabButtons = [...form.querySelectorAll("[data-step-tab]")];
    const deliveryFloorLabel = document.getElementById("delivery-floor-label");
    const buildingPlace = document.getElementById("building-place");
    const buildingPlaceName = document.getElementById("building-place-name");
    const buildingPlaceAddress = document.getElementById("building-place-address");
    const buildingNameInput = form.querySelector('input[name="building_name"]');
    const buildingAddressInput = form.querySelector('input[name="building_address"]');
    const deliveryPlaceInput = form.querySelector('input[name="delivery_place"]');

    function parseDeliveryPlaceFromUrl(search = window.location.search) {
        const raw = new URLSearchParams(search).get("delivery_place");
        if (raw == null) return "";
        return String(raw).trim();
    }

    const deliveryPlace = parseDeliveryPlaceFromUrl() || "Miejsce dostawy";

    const stepMeta = {
        parking: {
            title: "Gdzie najlepiej zaparkować?",
            desc: "Wskaż miejsce parkingowe, z którego najłatwiej dotrzeć do wejścia.",
            nextLabel: "Dalej →",
        },
        entrance: {
            title: "Którym wejściem wejść?",
            desc: "Wskaż właściwe wejście do budynku. Dodaj zdjęcie, aby ułatwić kurierowi.",
            nextLabel: "Dalej →",
        },
        destination: {
            title: "Gdzie dostarczyć przesyłkę?",
            desc: "Wskaż dokładne miejsce dostawy w budynku.",
            nextLabel: "Zapisz lokalizację ✓",
        },
    };

    let stepIndex = 0;
    let maxStepIndex = 0;

    const DEFAULT_FLOOR = "2";

    function floorLabel(value) {
        if (value === "0") return "parter";
        if (value === "-1") return "piwnica";
        return `${value} piętro`;
    }

    function floorDisplayLabel(level) {
        if (level === 0) return "0";
        if (level === -1) return "-1";
        return String(level);
    }

    function buildFloorPicker({ minLevel, maxLevel }) {
        if (!floorPicker) return;

        const min = Number(minLevel);
        const max = Number(maxLevel);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return;

        const previous = form.querySelector('input[name="delivery_floor"]:checked')?.value;
        floorPicker.querySelectorAll(".floor-option").forEach((node) => node.remove());

        const levels = [];
        for (let level = max; level >= min; level -= 1) {
            levels.push(level);
        }

        const preferred =
            previous && levels.some((level) => String(level) === previous)
                ? previous
                : levels.includes(Number(DEFAULT_FLOOR))
                  ? DEFAULT_FLOOR
                  : String(levels[Math.floor(levels.length / 2)] ?? maxLevel);

        levels.forEach((level) => {
            const value = String(level);
            const label = document.createElement("label");
            label.className = "floor-option";

            const input = document.createElement("input");
            input.type = "radio";
            input.name = "delivery_floor";
            input.value = value;
            if (value === preferred) input.checked = true;

            const span = document.createElement("span");
            span.textContent = floorDisplayLabel(level);

            label.append(input, span);
            floorPicker.append(label);

            input.addEventListener("change", updateDeliveryFloorLabel);
        });
    }

    function updateDeliveryFloorLabel() {
        const selected = form.querySelector('input[name="delivery_floor"]:checked');
        if (deliveryFloorLabel && selected) {
            deliveryFloorLabel.textContent = `${deliveryPlace}, ${floorLabel(selected.value)}`;
        }
    }

    function updateStepIcon(button, iconName) {
        const circle = button.querySelector(".tup-stepper__circle");
        if (!circle) return;
        circle.innerHTML = `<i data-lucide="${iconName}"></i>`;
    }

    function updateNavState() {
        const stepItems = [...form.querySelectorAll(".tup-stepper__step")];

        tabButtons.forEach((button, index) => {
            const unlocked = index <= maxStepIndex;
            const isComplete = unlocked && index < stepIndex;
            const isActive = index === stepIndex;

            button.classList.toggle("active", isActive);
            button.classList.toggle("is-complete", isComplete);
            button.classList.toggle("tup-stepper__item--locked", !unlocked);
            button.disabled = !unlocked;
            button.setAttribute("aria-disabled", String(!unlocked));
            if (isActive) button.setAttribute("aria-current", "step");
            else button.removeAttribute("aria-current");

            const label = button.querySelector(".tup-stepper__label")?.textContent?.trim() || "";
            if (isComplete) button.setAttribute("aria-label", `${label} — ukończono`);
            else if (isActive) button.setAttribute("aria-label", `${label} — bieżący krok`);
            else button.removeAttribute("aria-label");

            updateStepIcon(
                button,
                isComplete ? "check" : STEP_ICONS[STEPS[index]]
            );

            const stepItem = stepItems[index];
            if (stepItem) stepItem.classList.toggle("is-reached", unlocked && index > 0);
        });

        window.TupTupStepper?.refreshIcons();
    }

    function goToStep(index, { fromNav = false } = {}) {
        if (index < 0 || index >= STEPS.length) return;
        if (fromNav && index > maxStepIndex) return;

        stepIndex = index;
        const step = STEPS[stepIndex];
        const meta = stepMeta[step];

        sheetSteps.forEach((panel) => {
            panel.hidden = panel.dataset.step !== step;
        });

        if (heroTitle) heroTitle.textContent = meta.title;
        if (heroDesc) heroDesc.textContent = meta.desc;

        if (floorPicker) floorPicker.hidden = step !== "destination";

        if (backButton) {
            const onFirstStep = stepIndex === 0;
            backButton.classList.toggle("icon-button--ghost", onFirstStep);
            backButton.tabIndex = onFirstStep ? -1 : 0;
        }

        if (stepAction) {
            const isLast = stepIndex === STEPS.length - 1;
            stepAction.textContent = meta.nextLabel;
            stepAction.type = isLast ? "submit" : "button";
        }

        updateNavState();
        window.TupTupSheet?.collapse();
        window.TupTupMap?.setWizardStep(step);
    }

    function nextStep() {
        if (stepIndex >= STEPS.length - 1) return;
        maxStepIndex = Math.max(maxStepIndex, stepIndex + 1);
        goToStep(stepIndex + 1);
    }

    function prevStep() {
        if (stepIndex > 0) goToStep(stepIndex - 1);
    }

    tabButtons.forEach((button, index) => {
        button.addEventListener("click", () => {
            goToStep(index, { fromNav: true });
        });
    });

    backButton?.addEventListener("click", prevStep);

    stepAction?.addEventListener("click", (event) => {
        if (stepIndex < STEPS.length - 1) {
            event.preventDefault();
            nextStep();
        }
    });

    document.addEventListener("tuptup:coords", (event) => {
        const { parking, entrance, delivery } = event.detail;
        const pairs = [
            ["parking_lat", parking[0]],
            ["parking_lng", parking[1]],
            ["entrance_lat", entrance[0]],
            ["entrance_lng", entrance[1]],
            ["delivery_lat", delivery[0]],
            ["delivery_lng", delivery[1]],
        ];

        pairs.forEach(([name, value]) => {
            const field = form.elements[name];
            if (field) field.value = String(value);
        });
    });

    form.querySelectorAll(".photo-card").forEach((card) => {
        const input = card.querySelector(".photo-input");
        if (!input) return;

        const addLabel = card.getAttribute("aria-label") || "Dodaj zdjęcie";
        let preview = card.querySelector(".photo-card-image");

        let removeBtn = card.querySelector(".photo-remove");
        if (!removeBtn) {
            removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "photo-remove no-print";
            removeBtn.setAttribute("aria-label", "Usuń zdjęcie");
            removeBtn.textContent = "✕";
            card.appendChild(removeBtn);
        }

        function setAddState() {
            card.classList.add("add");
            card.classList.remove("has-photo");
            card.setAttribute("role", "button");
            card.setAttribute("tabindex", "0");
            card.setAttribute("aria-label", addLabel);
        }

        function setPhotoState() {
            card.classList.add("has-photo");
            card.classList.remove("add");
            card.setAttribute("role", "group");
            card.setAttribute("tabindex", "0");
            card.setAttribute("aria-label", "Zmień zdjęcie");
        }

        function showPreview(dataUrl) {
            if (!preview) {
                preview = document.createElement("img");
                preview.className = "photo-card-image";
                card.insertBefore(preview, input);
            }
            preview.src = dataUrl;
            preview.alt = "Podgląd zdjęcia";
            setPhotoState();
        }

        function clearPhoto() {
            input.value = "";
            if (preview) {
                preview.remove();
                preview = null;
            }
            setAddState();
        }

        function openPicker() {
            input.click();
        }

        card.addEventListener("click", (event) => {
            if (event.target.closest(".photo-remove")) return;
            openPicker();
        });
        card.addEventListener("keydown", (event) => {
            if (event.target.closest(".photo-remove")) return;
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPicker();
            }
        });

        removeBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            clearPhoto();
        });

        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => showPreview(reader.result);
            reader.readAsDataURL(file);
        });
    });

    form.addEventListener("submit", (event) => {
        if (stepIndex !== STEPS.length - 1) {
            event.preventDefault();
            return;
        }
        event.preventDefault();
        const payload = new FormData(form);
        console.info("TupTup — dane formularza:", Object.fromEntries(payload.entries()));
        alert("Lokalizacja zapisana (podgląd w konsoli deweloperskiej).");
    });

    let bootstrapped = false;

    function bootstrap() {
        if (bootstrapped) return;
        bootstrapped = true;

        if (deliveryPlaceInput) deliveryPlaceInput.value = deliveryPlace;
        updateDeliveryFloorLabel();
        goToStep(0);

        const initialPoints = window.TupTupMap?.getPoints();
        if (initialPoints) {
            document.dispatchEvent(
                new CustomEvent("tuptup:coords", { detail: initialPoints })
            );
        }
    }

    document.addEventListener("tuptup:map-ready", bootstrap, { once: true });
    function applyBuildingPlace({ name, address }) {
        const hasName = Boolean(name);
        const hasAddress = Boolean(address);

        if (buildingNameInput) buildingNameInput.value = name || "";
        if (buildingAddressInput) buildingAddressInput.value = address || "";

        if (buildingPlaceName) {
            buildingPlaceName.textContent = name || "";
            buildingPlaceName.hidden = !hasName;
        }
        if (buildingPlaceAddress) {
            buildingPlaceAddress.textContent = address || "";
            buildingPlaceAddress.hidden = !hasAddress;
        }
        if (buildingPlace) {
            buildingPlace.hidden = !hasName && !hasAddress;
        }
    }

    document.addEventListener("tuptup:building", (event) => {
        const { minLevel, maxLevel, name, address } = event.detail;
        applyBuildingPlace({ name, address });
        buildFloorPicker({ minLevel, maxLevel });
        updateDeliveryFloorLabel();
        const step = STEPS[stepIndex];
        if (step) window.TupTupMap?.setWizardStep(step);
    });

    window.TupTupFlow = {
        getStepIndex: () => stepIndex,
        goToStep: (index) => goToStep(index),
    };

    if (window.TupTupMap) bootstrap();
})();

(function () {
    const form = document.getElementById("recipient-form");
    if (!form) return;

    const STEPS = ["parking", "entrance", "floor", "destination"];
    const STEP_ICONS = {
        parking: "circle-parking",
        entrance: "door-closed",
        floor: "layers",
        destination: "map-pin",
    };
    const heroTitle = document.getElementById("hero-title");
    const heroDesc = document.getElementById("hero-desc");
    const elevatorPanel = document.getElementById("elevator-panel");
    const deliveryFloorInput = document.getElementById("delivery-floor-input");
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
        floor: {
            title: "Wybierz piętro",
            desc: "Wybierz piętro z listy i wskaż na mapie, gdzie się ono znajduje (np. winda, klatka).",
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

    const wizardState = {
        deliveryFloor: null,
        floorRange: null,
    };

    /** Zakres pięter z OSM (building:min_level, building:levels) — ustawiany przy tuptup:building */
    let osmFloorRange = null;

    const DEFAULT_FLOOR = "2";

    function applyOsmFloorRange({ minLevel, maxLevel, levels } = {}) {
        const min = Number(minLevel);
        const max = Number(maxLevel);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return false;

        osmFloorRange = {
            minLevel: min,
            maxLevel: max,
            levels: Number.isFinite(Number(levels)) ? Number(levels) : max - min + 1,
        };
        wizardState.floorRange = { min, max };
        return true;
    }

    function resolveOsmFloorRange() {
        if (osmFloorRange) return osmFloorRange;
        const fromMap = window.TupTupMap?.getBuildingFloorRange?.();
        if (fromMap && applyOsmFloorRange(fromMap)) return osmFloorRange;
        return null;
    }

    function syncElevatorPanelFromOsm() {
        const range = resolveOsmFloorRange();
        if (!range) return;
        buildElevatorPanel(range);
    }

    function floorLabel(value) {
        if (value === "0") return "parter";
        if (value === "-1") return "parking";
        return `${value} piętro`;
    }

    function floorSubtitle(level) {
        if (level === -1) return "Parking";
        if (level === 0) return "Parter";
        return `Piętro ${level}`;
    }

    function getSelectedFloor() {
        return wizardState.deliveryFloor ?? deliveryFloorInput?.value ?? null;
    }

    function setSelectedFloor(value, { scroll = false, animate = false } = {}) {
        if (value == null || !elevatorPanel) return;
        wizardState.deliveryFloor = String(value);
        if (deliveryFloorInput) deliveryFloorInput.value = wizardState.deliveryFloor;

        elevatorPanel.querySelectorAll(".elevator-floor").forEach((button) => {
            const selected = button.dataset.level === wizardState.deliveryFloor;
            button.classList.toggle("is-selected", selected);
            button.setAttribute("aria-selected", String(selected));
            if (selected) {
                if (scroll) {
                    button.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
                }
                if (animate) {
                    button.classList.remove("is-pressed");
                    void button.offsetWidth;
                    button.classList.add("is-pressed");
                    window.setTimeout(() => button.classList.remove("is-pressed"), 320);
                }
            }
        });

        updateDeliveryFloorLabel();
        document.dispatchEvent(
            new CustomEvent("tuptup:floor", { detail: { value: wizardState.deliveryFloor } })
        );
    }

    function buildElevatorPanel({ minLevel, maxLevel } = {}) {
        if (!elevatorPanel) return;

        const min = Number(minLevel);
        const max = Number(maxLevel);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return;

        wizardState.floorRange = { min, max };

        const levels = [];
        for (let level = max; level >= min; level -= 1) {
            levels.push(level);
        }

        const previous = getSelectedFloor();
        const preferred =
            previous && levels.some((level) => String(level) === previous)
                ? previous
                : levels.includes(Number(DEFAULT_FLOOR))
                  ? DEFAULT_FLOOR
                  : String(levels[Math.floor(levels.length / 2)] ?? max);

        elevatorPanel.replaceChildren();

        levels.forEach((level) => {
            const value = String(level);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "elevator-floor";
            button.dataset.level = value;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", "false");

            const digit = document.createElement("span");
            digit.className = "elevator-floor__digit";
            digit.textContent = value;

            const caption = document.createElement("span");
            caption.className = "elevator-floor__caption";
            caption.textContent = floorSubtitle(level);

            button.append(digit, caption);
            button.addEventListener("click", () => {
                setSelectedFloor(value, { scroll: true, animate: true });
            });

            elevatorPanel.append(button);
        });

        setSelectedFloor(preferred, { scroll: false });
        requestAnimationFrame(() => {
            setSelectedFloor(preferred, { scroll: true });
        });
    }

    function updateDeliveryFloorLabel() {
        const selected = getSelectedFloor();
        if (deliveryFloorLabel && selected) {
            deliveryFloorLabel.textContent = `${deliveryPlace}, ${floorLabel(selected)}`;
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
        const isFloorStep = step === "floor";

        sheetSteps.forEach((panel) => {
            panel.hidden = panel.dataset.step !== step;
        });

        if (heroTitle) heroTitle.textContent = meta.title;
        if (heroDesc) heroDesc.textContent = meta.desc;

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
        if (isFloorStep) {
            window.TupTupSheet?.expand();
            syncElevatorPanelFromOsm();
        } else {
            window.TupTupSheet?.collapse();
        }
        window.TupTupMap?.setWizardStep(step);

        if (isFloorStep) {
            const selected = elevatorPanel?.querySelector(".elevator-floor.is-selected");
            selected?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        }
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
        const { parking, entrance, delivery, floorIndicator } = event.detail;
        const pairs = [
            ["parking_lat", parking[0]],
            ["parking_lng", parking[1]],
            ["entrance_lat", entrance[0]],
            ["entrance_lng", entrance[1]],
            ["delivery_lat", delivery[0]],
            ["delivery_lng", delivery[1]],
        ];

        if (floorIndicator) {
            pairs.push(["floor_lat", floorIndicator[0]], ["floor_lng", floorIndicator[1]]);
        }

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
        syncElevatorPanelFromOsm();
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
        const { minLevel, maxLevel, levels, name, address } = event.detail;
        applyBuildingPlace({ name, address });
        if (applyOsmFloorRange({ minLevel, maxLevel, levels })) {
            buildElevatorPanel(osmFloorRange);
        }
        const step = STEPS[stepIndex];
        if (step) window.TupTupMap?.setWizardStep(step);
    });

    window.TupTupFlow = {
        getStepIndex: () => stepIndex,
        goToStep: (index) => goToStep(index),
        getWizardState: () => ({ ...wizardState, deliveryFloor: getSelectedFloor() }),
        getSelectedFloor,
        setSelectedFloor,
    };

    if (window.TupTupMap) bootstrap();
})();

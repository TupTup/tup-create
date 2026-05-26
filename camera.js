(function () {
    document.querySelectorAll(".photo-card").forEach((card) => {
        if (card.dataset.cameraInit) return;
        card.dataset.cameraInit = "true";

        let input = card.querySelector(".photo-input");
        if (!input) {
            input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.capture = "environment";
            input.hidden = true;
            input.className = "photo-input";
            card.appendChild(input);
        }

        let preview = card.querySelector(".photo-card-image");

        const addLabel = card.getAttribute("aria-label") || "Dodaj zdjęcie";

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
            input.value = "";
        });
    });
})();

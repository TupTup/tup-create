(function () {
    document.querySelectorAll(".photo-card").forEach((card) => {
        const button = card.querySelector(".camera-button");
        if (!button || card.dataset.cameraInit) return;
        card.dataset.cameraInit = "true";

        button.type = "button";

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "environment";
        input.hidden = true;
        input.className = "photo-input";
        card.appendChild(input);

        let preview = card.querySelector(".photo-card-image");

        function showPreview(dataUrl) {
            if (!preview) {
                preview = document.createElement("img");
                preview.className = "photo-card-image";
                card.insertBefore(preview, button);
            }

            preview.src = dataUrl;
            preview.alt = card.getAttribute("aria-label") || "Zdjęcie";
            card.classList.add("has-photo");
            button.setAttribute("aria-label", "Zmień zdjęcie");
        }

        button.addEventListener("click", () => input.click());

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

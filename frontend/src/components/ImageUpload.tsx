import { FileText, X } from "lucide-react";
import { isImageAttachmentType, maxAttachmentBytes } from "shared/types/index.js";

/**
 * The files the composer will attach: any type, within its size limit.
 * Images go to the model as images; anything else is saved and either inlined
 * or referenced by path (shared/types/attachment.ts).
 */
export function validateAttachmentFiles(fileList: FileList | File[]): File[] {
  const files = Array.from(fileList);
  const validFiles: File[] = [];

  for (const file of files) {
    if (file.size > maxAttachmentBytes(file.type)) {
      console.warn(`File too large: ${file.name} (${file.size} bytes)`);
      continue;
    }

    validFiles.push(file);
  }

  return validFiles;
}

interface Props {
  images: File[];
  onImagesChange: (images: File[]) => void;
}

export default function ImageUpload({ images, onImagesChange }: Props) {
  const removeImage = (index: number) => {
    const newImages = [...images];
    newImages.splice(index, 1);
    onImagesChange(newImages);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  if (images.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 8,
      }}
    >
      {images.map((image, index) => (
        <div
          key={`${image.name}-${index}`}
          style={{
            position: "relative",
            width: 80,
            height: 80,
            borderRadius: 8,
            overflow: "hidden",
            background: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          {isImageAttachmentType(image.type) ? (
            <img
              src={URL.createObjectURL(image)}
              alt={image.name}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
              onLoad={(e) => {
                URL.revokeObjectURL((e.target as HTMLImageElement).src);
              }}
            />
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "4px 4px 18px",
                color: "var(--text-muted)",
              }}
            >
              <FileText size={22} />
              <div
                style={{
                  fontSize: 10,
                  width: "100%",
                  textAlign: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text)",
                }}
              >
                {image.name}
              </div>
            </div>
          )}
          <button
            onClick={() => removeImage(index)}
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--surface)",
              border: "none",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
            title={isImageAttachmentType(image.type) ? "Remove image" : "Remove file"}
          >
            <X size={14} />
          </button>
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              background: "var(--overlay-bg)",
              color: "white",
              fontSize: 10,
              padding: "2px 4px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`${image.name} (${formatFileSize(image.size)})`}
          >
            {formatFileSize(image.size)}
          </div>
        </div>
      ))}
    </div>
  );
}

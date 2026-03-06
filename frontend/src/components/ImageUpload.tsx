import { useState, useRef, useCallback } from "react";
import { Paperclip, X } from "lucide-react";

interface Props {
  images: File[];
  onImagesChange: (images: File[]) => void;
  disabled?: boolean;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

export default function ImageUpload({ images, onImagesChange, disabled = false }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFiles = useCallback((fileList: FileList | File[]): File[] => {
    const files = Array.from(fileList);
    const validFiles: File[] = [];

    for (const file of files) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        console.warn(`Invalid file type: ${file.type}`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        console.warn(`File too large: ${file.size} bytes`);
        continue;
      }

      validFiles.push(file);
    }

    return validFiles;
  }, []);

  const handleFileSelect = useCallback(
    (fileList: FileList | File[]) => {
      const validFiles = validateFiles(fileList);
      if (validFiles.length > 0) {
        onImagesChange([...images, ...validFiles]);
      }
    },
    [images, onImagesChange, validateFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);

      if (disabled) return;

      const files = e.dataTransfer.files;
      if (files) {
        handleFileSelect(files);
      }
    },
    [disabled, handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) {
        setDragActive(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only hide drag state if leaving the component entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragActive(false);
    }
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFileSelect(e.target.files);
      }
      // Reset input
      e.target.value = "";
    },
    [handleFileSelect],
  );

  const removeImage = useCallback(
    (index: number) => {
      const newImages = [...images];
      newImages.splice(index, 1);
      onImagesChange(newImages);
    },
    [images, onImagesChange],
  );

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  return (
    <div>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        multiple
        onChange={handleFileInput}
        style={{ display: "none" }}
        disabled={disabled}
      />

      {/* Image previews */}
      {images.length > 0 && (
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
              <img
                src={URL.createObjectURL(image)}
                alt={image.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
                onLoad={(e) => {
                  // Clean up object URL to prevent memory leaks
                  URL.revokeObjectURL((e.target as HTMLImageElement).src);
                }}
              />
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
                title="Remove image"
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
      )}

      {/* Upload area */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onClick={() => !disabled && fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragActive ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 8,
          padding: 12,
          textAlign: "center" as const,
          cursor: disabled ? "default" : "pointer",
          background: dragActive ? "var(--accent-bg)" : "transparent",
          color: dragActive ? "var(--accent)" : "var(--text-muted)",
          fontSize: 13,
          transition: "all 0.2s ease",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {dragActive ? (
          <div>Drop images here</div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Paperclip size={16} />
              Click to upload or drag images here
            </div>
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>PNG, JPEG, GIF, WEBP up to 10MB each</span>
          </div>
        )}
      </div>
    </div>
  );
}

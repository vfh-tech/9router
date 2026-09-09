"use client";

/** Reusable status alert */
export default function StatusAlert({ status, className = "" }) {
  const renderMessage = (msg) => {
    const parts = msg.split(/(https?:\/\/[^\s]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline font-medium">{part}</a>
        : part
    );
  };

  return (
    <div className={`px-3 py-2 rounded-lg border text-sm ${className} ${status.type === "success" ? "bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400" :
        status.type === "warning" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-600 dark:text-yellow-400" :
        status.type === "info" ? "bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400" :
          "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}

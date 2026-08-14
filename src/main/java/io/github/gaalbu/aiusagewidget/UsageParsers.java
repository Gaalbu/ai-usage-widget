package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class UsageParsers {
    private static final DateTimeFormatter RESET_OTHER_DAY = DateTimeFormatter.ofPattern("EEE HH:mm", Locale.ENGLISH);

    private UsageParsers() {}

    static ArrayNode parseClaude(JsonNode payload, Clock clock) {
        Map<String, String> labels = new LinkedHashMap<>();
        labels.put("five_hour", "5-hour window");
        labels.put("seven_day", "7-day window");
        labels.put("seven_day_sonnet", "7-day Sonnet");
        labels.put("seven_day_opus", "7-day Opus");

        ArrayNode windows = JsonNodeFactory.instance.arrayNode();
        labels.forEach((key, label) -> {
            JsonNode value = payload.path(key);
            if (!value.isObject()) {
                return;
            }
            JsonNode used = value.hasNonNull("utilization")
                    ? value.get("utilization") : value.get("used_percentage");
            ObjectNode window = window(label, used, value.get("resets_at"), clock);
            if (window != null) {
                windows.add(window);
            }
        });
        return windows;
    }

    static ArrayNode parseCodex(JsonNode payload, Clock clock) {
        JsonNode buckets = payload.path("rateLimitsByLimitId");
        ObjectNode normalized = JsonNodeFactory.instance.objectNode();
        if (buckets.isObject() && !buckets.isEmpty()) {
            buckets.fields().forEachRemaining(entry -> normalized.set(entry.getKey(), entry.getValue()));
        } else {
            JsonNode fallback = payload.path("rateLimits");
            if (fallback.isObject()) {
                normalized.set(fallback.path("limitId").asText("codex"), fallback);
            }
        }

        ArrayNode windows = JsonNodeFactory.instance.arrayNode();
        normalized.fields().forEachRemaining(entry -> {
            String bucketName = entry.getKey();
            JsonNode bucket = entry.getValue();
            if (!bucket.isObject()) {
                return;
            }
            String displayName = bucket.path("limitName").asText();
            if (displayName.isBlank()) {
                displayName = bucketName.equals("codex") ? "Codex" : bucketName;
            }
            for (String windowName : new String[]{"primary", "secondary"}) {
                JsonNode value = bucket.path(windowName);
                if (!value.isObject()) {
                    continue;
                }
                String label = codexWindowLabel(windowName, value.get("windowDurationMins"));
                if (normalized.size() > 1) {
                    label = displayName + " · " + label;
                }
                ObjectNode window = window(label, value.get("usedPercent"), value.get("resetsAt"), clock);
                if (window != null) {
                    windows.add(window);
                }
            }
        });
        return windows;
    }

    static ObjectNode window(String label, JsonNode used, JsonNode reset, Clock clock) {
        if (used == null || !used.isNumber()) {
            return null;
        }
        double raw = used.asDouble();
        if (!Double.isFinite(raw)) {
            return null;
        }
        ObjectNode result = JsonNodeFactory.instance.objectNode();
        result.put("label", label);
        result.put("usedPercent", Math.max(0.0, Math.min(100.0, raw)));
        String resetLabel = resetLabel(reset, clock);
        if (resetLabel == null) {
            result.putNull("resetLabel");
        } else {
            result.put("resetLabel", resetLabel);
        }
        return result;
    }

    private static String codexWindowLabel(String fallback, JsonNode durationNode) {
        if (durationNode == null || !durationNode.canConvertToInt() || durationNode.asInt() == 0) {
            return Character.toUpperCase(fallback.charAt(0)) + fallback.substring(1);
        }
        int duration = durationNode.asInt();
        String period;
        if (duration % 10080 == 0) {
            period = duration / 10080 + "-week";
        } else if (duration % 1440 == 0) {
            period = duration / 1440 + "-day";
        } else if (duration % 60 == 0) {
            period = duration / 60 + "-hour";
        } else {
            period = duration + "-minute";
        }
        return period + " window";
    }

    private static String resetLabel(JsonNode value, Clock clock) {
        if (value == null || value.isNull()) {
            return null;
        }
        try {
            Instant instant = value.isNumber() ? Instant.ofEpochSecond(value.asLong()) : Instant.parse(value.asText());
            ZoneId zone = clock.getZone();
            ZonedDateTime reset = instant.atZone(zone);
            LocalDate today = LocalDate.now(clock);
            if (reset.toLocalDate().equals(today)) {
                return "resets today at " + reset.format(DateTimeFormatter.ofPattern("HH:mm"));
            }
            if (reset.toLocalDate().equals(today.plusDays(1))) {
                return "resets tomorrow at " + reset.format(DateTimeFormatter.ofPattern("HH:mm"));
            }
            return "resets " + reset.format(RESET_OTHER_DAY);
        } catch (DateTimeParseException | ArithmeticException ignored) {
            return null;
        }
    }
}

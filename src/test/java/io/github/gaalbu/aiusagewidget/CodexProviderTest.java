package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CodexProviderTest {
    @TempDir Path temporary;

    @Test
    void exchangesJsonRpcWithAppServerProcess() throws IOException, ProviderException {
        Path command = temporary.resolve("codex");
        Files.writeString(command, """
                #!/usr/bin/env bash
                set -euo pipefail
                head -n 3 >/dev/null
                printf '%s\\n' '{"id":2,"result":{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":1786237200},"secondary":{"usedPercent":31,"windowDurationMins":10080,"resetsAt":1786823146}}}}}'
                """);
        Files.setPosixFilePermissions(command, PosixFilePermissions.fromString("rwx------"));

        ObjectMapper mapper = new ObjectMapper();
        Clock clock = Clock.fixed(Instant.ofEpochSecond(2_000_000_000L), ZoneOffset.UTC);
        ObjectNode result = new CodexProvider(mapper, clock, Map.of("CODEX_BIN", command.toString())).collect();

        assertEquals("ok", result.path("status").asText());
        assertTrue(result.path("configured").asBoolean());
        assertEquals(2, result.path("windows").size());
        assertEquals(12.0, result.path("windows").get(0).path("usedPercent").asDouble());
    }
}

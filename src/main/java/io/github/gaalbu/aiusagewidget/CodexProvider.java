package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class CodexProvider implements UsageProvider {
    private static final int MAX_RESPONSE_CHARS = 1024 * 1024;
    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    private final ObjectMapper mapper;
    private final Clock clock;
    private final Map<String, String> environment;

    CodexProvider(ObjectMapper mapper, Clock clock, Map<String, String> environment) {
        this.mapper = mapper;
        this.clock = clock;
        this.environment = environment;
    }

    @Override
    public String name() {
        return "codex";
    }

    @Override
    public ObjectNode collect() throws ProviderException {
        Process process;
        try {
            process = new ProcessBuilder(codexCommand(), "app-server", "--stdio")
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException error) {
            throw new ProviderException("Could not start the Codex app-server", true, error);
        }

        try {
            writeRequests(process);
            JsonNode response = readResponse(process);
            if (response == null) {
                throw new ProviderException("Codex usage request timed out", true);
            }
            if (response.hasNonNull("error")) {
                throw new ProviderException("Codex rejected the usage request; run `codex login`", false);
            }
            ArrayNode windows = UsageParsers.parseCodex(response.path("result"), clock);
            if (windows.isEmpty()) {
                throw new ProviderException("Codex returned no usage windows", true);
            }
            ObjectNode result = mapper.createObjectNode();
            result.put("status", "ok");
            result.put("configured", true);
            result.set("windows", windows);
            return result;
        } finally {
            stop(process);
        }
    }

    private void writeRequests(Process process) throws ProviderException {
        ObjectNode initialize = mapper.createObjectNode();
        initialize.put("method", "initialize");
        initialize.put("id", 1);
        ObjectNode clientInfo = initialize.putObject("params").putObject("clientInfo");
        clientInfo.put("name", "ai_usage_widget");
        clientInfo.put("title", "AI Usage Widget");
        clientInfo.put("version", "0.2.0");

        ObjectNode initialized = mapper.createObjectNode();
        initialized.put("method", "initialized");
        initialized.putObject("params");

        ObjectNode readLimits = mapper.createObjectNode();
        readLimits.put("method", "account/rateLimits/read");
        readLimits.put("id", 2);
        readLimits.putObject("params");

        try {
            Writer writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8);
            for (JsonNode request : new JsonNode[]{initialize, initialized, readLimits}) {
                writer.write(mapper.writeValueAsString(request));
                writer.write('\n');
            }
            writer.flush();
        } catch (IOException error) {
            throw new ProviderException("Could not communicate with the Codex app-server", true, error);
        }
    }

    private JsonNode readResponse(Process process) throws ProviderException {
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<JsonNode> future = executor.submit(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                        process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.length() > MAX_RESPONSE_CHARS) {
                            throw new ProviderException("Codex usage response was unexpectedly large", true);
                        }
                        try {
                            JsonNode message = mapper.readTree(line);
                            if (message.path("id").asInt(-1) == 2) {
                                return message;
                            }
                        } catch (IOException ignored) {
                            // The app-server may emit unrelated non-JSON lines. Do not log them.
                        }
                    }
                    return null;
                }
            });
            return future.get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            throw new ProviderException("Codex usage request timed out", true, error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ProviderException("Codex usage request timed out", true, error);
        } catch (ExecutionException error) {
            if (error.getCause() instanceof ProviderException providerError) {
                throw providerError;
            }
            throw new ProviderException("Could not communicate with the Codex app-server", true, error);
        }
    }

    private String codexCommand() throws ProviderException {
        String override = environment.get("CODEX_BIN");
        if (override != null && !override.isBlank()) {
            return override;
        }
        String path = environment.getOrDefault("PATH", "");
        for (String directory : path.split(":")) {
            if (directory.isBlank()) {
                continue;
            }
            Path candidate = Path.of(directory).resolve("codex");
            if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                return candidate.toString();
            }
        }
        Path fallback = Path.of(environment.getOrDefault("HOME", System.getProperty("user.home")))
                .resolve(".local/bin/codex");
        if (Files.isRegularFile(fallback) && Files.isExecutable(fallback)) {
            return fallback.toString();
        }
        throw new ProviderException("Codex CLI not found in PATH", false);
    }

    private void stop(Process process) {
        if (!process.isAlive()) {
            return;
        }
        process.destroy();
        try {
            if (!process.waitFor(2, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        }
    }
}

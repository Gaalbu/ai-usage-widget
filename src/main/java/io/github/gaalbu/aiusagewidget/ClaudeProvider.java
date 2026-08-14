package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;

final class ClaudeProvider implements UsageProvider {
    static final URI USAGE_URI = URI.create("https://api.anthropic.com/api/oauth/usage");
    private static final String BETA = "oauth-2025-04-20";
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;

    private final ObjectMapper mapper;
    private final HttpClient client;
    private final Clock clock;
    private final Map<String, String> environment;

    ClaudeProvider(ObjectMapper mapper, HttpClient client, Clock clock, Map<String, String> environment) {
        this.mapper = mapper;
        this.client = client;
        this.clock = clock;
        this.environment = environment;
    }

    @Override
    public String name() {
        return "claude";
    }

    @Override
    public ObjectNode collect() throws ProviderException {
        String token = readToken();
        HttpRequest request = HttpRequest.newBuilder(USAGE_URI)
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + token)
                .header("anthropic-beta", BETA)
                .header("User-Agent", "ai-usage-widget/0.2.0")
                .GET()
                .build();
        try {
            HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() == 401) {
                throw new ProviderException("Claude login expired; open Claude Code to refresh it", true);
            }
            if (response.statusCode() == 429) {
                throw new ProviderException("Claude usage is temporarily rate-limited", true);
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ProviderException("Claude usage request failed (HTTP " + response.statusCode() + ")", true);
            }
            if (response.body().length > MAX_RESPONSE_BYTES) {
                throw new ProviderException("Claude usage response was unexpectedly large", true);
            }
            ArrayNode windows = UsageParsers.parseClaude(mapper.readTree(response.body()), clock);
            if (windows.isEmpty()) {
                throw new ProviderException("Claude returned no supported usage windows", true);
            }
            return success(windows);
        } catch (ProviderException error) {
            throw error;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ProviderException("Claude usage service is unavailable", true, error);
        } catch (IOException | RuntimeException error) {
            throw new ProviderException("Claude usage service is unavailable", true, error);
        }
    }

    private String readToken() throws ProviderException {
        String configuredDir = environment.getOrDefault("CLAUDE_CONFIG_DIR", "~/.claude");
        Path directory = expandHome(configuredDir);
        try {
            JsonNode credentials = mapper.readTree(Files.readString(directory.resolve(".credentials.json")));
            String token = credentials.path("claudeAiOauth").path("accessToken").asText();
            if (token.isBlank()) {
                throw new ProviderException("Claude OAuth login not found; run `claude auth login`", false);
            }
            return token;
        } catch (ProviderException error) {
            throw error;
        } catch (IOException error) {
            throw new ProviderException("Claude credentials not found; run `claude auth login`", false, error);
        }
    }

    private Path expandHome(String value) {
        if (value.equals("~")) {
            return Path.of(environment.getOrDefault("HOME", System.getProperty("user.home")));
        }
        if (value.startsWith("~/")) {
            return Path.of(environment.getOrDefault("HOME", System.getProperty("user.home"))).resolve(value.substring(2));
        }
        return Path.of(value);
    }

    private ObjectNode success(ArrayNode windows) {
        ObjectNode result = mapper.createObjectNode();
        result.put("status", "ok");
        result.put("configured", true);
        result.set("windows", windows);
        return result;
    }
}

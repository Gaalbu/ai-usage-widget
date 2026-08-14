package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;

final class CacheStore {
    static final long MAX_AGE_SECONDS = 30 * 60;
    private static final long MAX_CACHE_BYTES = 256 * 1024;
    private static final Set<PosixFilePermission> DIRECTORY_PERMISSIONS = Set.of(
            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE);
    private static final Set<PosixFilePermission> FILE_PERMISSIONS = Set.of(
            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);

    private final ObjectMapper mapper;
    private final Path path;

    CacheStore(ObjectMapper mapper, Path path) {
        this.mapper = mapper;
        this.path = path;
    }

    ObjectNode read() {
        try {
            BasicFileAttributes attributes = Files.readAttributes(
                    path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_CACHE_BYTES) {
                return mapper.createObjectNode();
            }
            JsonNode payload = mapper.readTree(Files.readAllBytes(path));
            return payload instanceof ObjectNode object ? object : mapper.createObjectNode();
        } catch (IOException | RuntimeException ignored) {
            return mapper.createObjectNode();
        }
    }

    void write(ObjectNode payload) {
        Path temporary = null;
        try {
            Path parent = path.getParent();
            Files.createDirectories(parent);
            if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            setPermissions(parent, DIRECTORY_PERMISSIONS);
            temporary = Files.createTempFile(parent, ".usage.", ".tmp");
            setPermissions(temporary, FILE_PERMISSIONS);
            Files.write(temporary, mapper.writeValueAsBytes(payload));
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
            temporary = null;
            setPermissions(path, FILE_PERMISSIONS);
        } catch (IOException | UnsupportedOperationException ignored) {
            // Caching is best-effort; a read-only home must not break live usage.
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException ignored) {
                    // Best-effort cleanup.
                }
            }
        }
    }

    ObjectNode freshProvider(ObjectNode cached, String name, long now) {
        JsonNode previous = cached.path("providers").path(name);
        JsonNode windows = previous.path("windows");
        if (!previous.isObject() || !windows.isArray() || windows.isEmpty()) {
            return null;
        }
        JsonNode cachedAtNode = previous.hasNonNull("cachedAt")
                ? previous.get("cachedAt") : cached.get("updatedAt");
        if (cachedAtNode == null || !cachedAtNode.isNumber()) {
            return null;
        }
        long cachedAt = cachedAtNode.asLong();
        long age = now - cachedAt;
        if (age < 0 || age > MAX_AGE_SECONDS) {
            return null;
        }
        ObjectNode result = mapper.createObjectNode();
        result.put("cachedAt", cachedAt);
        result.set("windows", windows.deepCopy());
        return result;
    }

    private void setPermissions(Path target, Set<PosixFilePermission> permissions) throws IOException {
        try {
            Files.setPosixFilePermissions(target, permissions);
        } catch (UnsupportedOperationException ignored) {
            // Ubuntu uses POSIX permissions; retaining portability costs nothing.
        }
    }
}
